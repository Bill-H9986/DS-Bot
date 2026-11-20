// DS-BB-012 boot probe: boot the pinned DSH runtime in-process from a scratch DSH_HOME and
// report which public services are defined, and whether it can create + read a Session.
// Imports the runtime through absolute paths into app/node_modules (the installed 0.2.2-rc.1).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const APP = 'C:/Users/24268/Desktop/Development/DS-Bot-Base/.claude/worktrees/fervent-darwin-188c56/app'
const pkg = sub => `file://${join(APP, 'node_modules/@deepseek-ai', sub)}`.replace(/\\/g, '/')
const appBoot = await import(pkg('dsh-app-boot/lib/index.js'))
const dsh = await import(pkg('dsh/lib/profile-boot.js'))

const home = process.env.DSBB012_PROBE_HOME ?? join(tmpdir(), `dsbb012-probe-${process.pid}`)
mkdirSync(home, { recursive: true })
process.env.DSH_HOME = home
process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:9/v1' // not used here (no turn)
process.env.DEEPSEEK_API_KEY = 'sk-mock-dsbb012' // local mock only; the mock server never validates it

const profileDir = join(home, 'profiles', 'dsbb012')
mkdirSync(profileDir, { recursive: true })
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-dsbb012',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
}, null, 2))
// Disable the browser-UI tree (no built frontend dist in the published package) so the host
// services mount without needing a web bundle. Keep the host rows the R-remap needs.
writeFileSync(join(profileDir, 'cordis.patch.yml'), [
  '[]',
].join('\n'))

const environment = appBoot.loadLayeredEnv('dsh')
const profile = appBoot.loadProfileDirectory('dsh', profileDir, join(APP, 'package.json'))
console.log('skippedBundles:', JSON.stringify(profile.skippedBundles))

const run = dsh.runProfile({
  environment,
  profile: 'dsbb012',
  resolvedProfile: { profile, installAnchor: join(APP, 'package.json') },
  patchFiles: [],
  args: ['--no-open', '--port', '0'],
}).catch(error => { console.error('BOOT FAILED:', error?.message ?? error); return null })

// Give boot a moment to settle, then inspect.
await new Promise(resolve => setTimeout(resolve, 8000))
const app = await run
if (!app) process.exit(3)
const { ctx } = app
for (const name of ['sessionController', 'workingDirectory', 'agents', 'workspaceRegistry', 'sessions', 'agentDefaultModel', 'llm', 'sessionPersistence', 'sessionProjections', 'systemPrompt']) {
  console.log(`ctx.${name} =`, ctx.get(name) === undefined ? '(undefined)' : 'defined')
}
await app.shutdown.shutdown(0)
console.log('SHUT DOWN cleanly')
process.exit(0)
