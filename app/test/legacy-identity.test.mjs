// DS-Bot-Base's own product identity: its own appId, installer GUID and shell-data directory,
// so it coexists with the old DS Bot. Its own Chromium encryption identity is kept stable
// across in-place starts of its own install; the old product's directories are never adopted.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { parse } from 'yaml'
import { APP_ID, configureIdentity, LEGACY_ARTIFACT_PREFIX, PRODUCT_NAME, SHELL_DATA_DIR } from '../src/legacy.mjs'

// The old product's published identity, which this one must never reuse or upgrade.
const OLD_APP_ID = 'io.github.fei2411.dsbot'
const OLD_NSIIS_GUID = '32c46dfc-ed78-5d41-85a4-a3c7f083f2e0'
// The installer GUID this product publishes, fixed for its life and never regenerated.
const NSIIS_GUID = 'cf83dddd-4347-491c-8c16-aede2ad61506'

function fixture({ saved = [] } = {}) {
  const app = new EventEmitter()
  const appData = join(tmpdir(), 'dsbot-base-identity-fixture')
  const current = join(appData, SHELL_DATA_DIR)
  const legacy = join(appData, 'DeepSeek Bot')
  const paths = { appData, userData: current }
  const names = []
  Object.assign(app, {
    getPath: name => paths[name],
    setPath: (name, value) => { paths[name] = value },
    setName: name => names.push(name),
    setAppUserModelId: id => { app.id = id },
  })
  const exists = path => saved.includes(path)
  return { app, paths, names, current, legacy, exists }
}

// A start of an installed copy keeps its own shell data and, off Windows, its captured
// encryption identity (pinned under the product name before ready, restored after).
for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform}: an installed copy keeps its own shell data and encryption identity`, () => {
    const f = fixture()
    const own = join(tmpdir(), 'dsbot-base-identity-fixture', SHELL_DATA_DIR)
    let created
    const options = { env: {}, platform, mkdir: path => { created = path }, exists: path => path === own }
    assert.deepEqual(configureIdentity(f.app, options), { userData: own, upgrade: true })
    assert.equal(f.paths.sessionData, own)
    assert.equal(created, own, 'its own directory is prepared, not anyone else’s')
    if (platform === 'win32') {
      assert.equal(f.app.id, APP_ID)
      assert.deepEqual(f.names, [], 'Windows decrypts per user; no name capture')
    } else {
      assert.deepEqual(f.names, [PRODUCT_NAME], 'the identity is pinned under the new name before ready')
      f.app.emit('ready')
      assert.deepEqual(f.names, [PRODUCT_NAME, PRODUCT_NAME], 'the visible name is restored after ready')
    }
  })
}

// A first install uses its own directory and touches no one else’s.
test('a fresh installation uses its own shell directory, not the old product’s', () => {
  const f = fixture()
  const own = join(tmpdir(), 'dsbot-base-identity-fixture', SHELL_DATA_DIR)
  assert.deepEqual(configureIdentity(f.app, { env: {}, platform: 'linux', mkdir: () => {}, exists: path => path !== own }), { userData: own, upgrade: false })
  assert.deepEqual(f.names, [])
  assert.notEqual(f.paths.userData, join(tmpdir(), 'dsbot-base-identity-fixture', 'DeepSeek Bot'))
})

// An installed copy of the old DS Bot must not be adopted as this product’s active data:
// this app never reads or reuses the old shell data or keychain identity.
test('an old product’s installed copy is not adopted', () => {
  const f = fixture()
  const own = join(tmpdir(), 'dsbot-base-identity-fixture', SHELL_DATA_DIR)
  const legacy = join(tmpdir(), 'dsbot-base-identity-fixture', 'DeepSeek Bot')
  const result = configureIdentity(f.app, { env: {}, platform: 'darwin', mkdir: () => {}, exists: path => path === legacy })
  assert.equal(result.userData, own, 'its own directory, even when the old one exists')
  assert.equal(result.upgrade, false, 'the old directory is not an upgrade of this product')
  assert.deepEqual(f.names, [], 'the old product’s captured identity is not reused')
})

// An explicit shell directory is used as-is; nothing is probed.
test('an explicit shell directory never probes installed user data', () => {
  const f = fixture()
  const explicit = join(tmpdir(), 'dsbot-base-custom-shell')
  assert.equal(configureIdentity(f.app, { env: { DS_BOT_SHELL_DATA: explicit }, mkdir: () => {}, exists: () => { throw new Error('must not probe') } }).userData, explicit)
  assert.equal(f.paths.sessionData, explicit)
})

// A throwaway data root (development and tests) keeps the default shell directory and probes nothing.
test('an isolated data run never probes an installed application', () => {
  const f = fixture()
  const own = join(tmpdir(), 'dsbot-base-identity-fixture', SHELL_DATA_DIR)
  assert.equal(configureIdentity(f.app, { env: { DS_BOT_HOME: '/tmp/dsbot-base-test-data' }, mkdir: () => {}, exists: () => { throw new Error('must not probe') } }).userData, own)
})

// The old-client release aliases stay intact: they carry the DeepSeek Bot era.
for (const suffix of ['mac-arm64.zip', 'mac-x64.zip', 'linux-amd64.deb']) {
  test(`old update clients receive the identical DS Bot payload: ${suffix}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'dsbot-release-alias-'))
    try {
      const source = join(root, `DS-Bot-1.2.3-${suffix}`)
      const payload = Buffer.from('new DS Bot package')
      writeFileSync(source, payload)
      const result = spawnSync(process.execPath, ['scripts/legacy-release-assets.mjs', source], { cwd: new URL('../', import.meta.url), encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      const alias = join(root, `${LEGACY_ARTIFACT_PREFIX}-1.2.3-${suffix}`)
      assert.deepEqual(readFileSync(alias), payload)
      assert.equal(existsSync(source), true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}

// The installer identity is the new product's own, and is not the old product's.
test('the published installer identity is new and separated from the old product', () => {
  const config = parse(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
  assert.equal(config.appId, APP_ID)
  assert.equal(config.nsis.guid, NSIIS_GUID)
  assert.equal(config.productName, PRODUCT_NAME)
  assert.notEqual(APP_ID, OLD_APP_ID, 'a new appId, not the old one')
  assert.notEqual(config.nsis.guid, OLD_NSIIS_GUID, 'a new GUID, not the old one')
  // The GUID is a fixed literal in the config, not a value derived from the appId, so a
  // later appId change can never silently regenerate it.
  assert.match(config.nsis.guid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/iu)
})
