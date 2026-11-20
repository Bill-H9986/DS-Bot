// DS-BB-012 orchestrator: drives the isolated validation end to end, each engine stage in
// its own fresh process (a stage boundary is a real engine restart). The mock LLM is the
// existing ds-bot/dev/mock-llm.mjs, kept alive for the whole run and stopped at the end.
//
//   node run.mjs all          # setup → 012-B → 012-C → 012-D → 012-E → 012-F → 012-G → finish
//   node run.mjs <stage>      # one stage: setup|b|c|d|e|f|g|finish
//
// All data lives under .dsh-test-dsbb012/ (gitignored bench convention); nothing under
// ~/.dsh or the app's DSH_HOME is touched. Evidence accumulates in
// docs/process/dsbb012-artifacts/ as JSON results, console logs, and integrity snapshots.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import {
  createWriteStream, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { snapshotArtifact, prefixRelation, readAll } from './frames.mjs'

const HERE = dirname(fileURLToPath(import.meta.url)) // <repo>/ds-bot/dev/dsbb012
const REPO = join(dirname(dirname(dirname(HERE))))
const DATA = join(REPO, '.dsh-test-dsbb012')
const ART = join(REPO, 'docs', 'process', 'dsbb012-artifacts')
const HOME = join(DATA, 'dsh-home') // the isolated DSH_HOME
const OLD_DIR = join(DATA, 'workspaces', 'old-team-ws')
const NEW_DIR = join(DATA, 'workspaces', 'new-team-ws')
const MOCK_LOG = join(DATA, 'mock.jsonl')
const SESSION_ID = 'dsbb012-session-001'
const CONTROL_ID = 'dsbb012-control-001'

const stageArg = process.argv[2] ?? 'all'

// --- helpers ---------------------------------------------------------------

function grabFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

const pathsFile = () => join(DATA, 'paths.json')

function recordPaths(extra) {
  const record = {
    generatedAt: new Date().toISOString(),
    repo: REPO,
    dataRoot: DATA,
    dshHome: HOME,
    oldDir: OLD_DIR,
    newDir: NEW_DIR,
    mockLog: MOCK_LOG,
    sessionId: SESSION_ID,
    controlId: CONTROL_ID,
    isolation: {
      // The test tree is entirely under the repo; the user's ~/.dsh and the app's own
      // DSH_HOME are not referenced anywhere in this record.
      userDshTouched: false,
      appDshHomeTouched: false,
      note: 'DSH_HOME is set to the data root; loadLayeredEnv finds no .env under the data root or the repo root, so no user environment layer is read.',
    },
    ...extra,
  }
  mkdirSync(DATA, { recursive: true })
  writeFileSync(pathsFile(), JSON.stringify(record, null, 2) + '\n')
  return record
}

function loadPaths() {
  const record = readJson(pathsFile())
  if (record === null) throw new Error('paths.json missing — run the setup stage first')
  return record
}

// Run one engine stage in a fresh node process; capture its console log to the artifact dir.
async function runStage(stage) {
  const paths = loadPaths()
  const out = join(ART, `stage-${stage}.json`)
  const logPath = join(ART, `stage-${stage}.log`)
  const args = {
    home: HOME,
    oldDir: OLD_DIR,
    newDir: NEW_DIR,
    mockPort: paths.mockPort,
    mockLog: MOCK_LOG,
    out,
    sessionId: SESSION_ID,
    controlId: CONTROL_ID,
  }
  const argsFile = join(DATA, `args-${stage}.json`)
  writeFileSync(argsFile, JSON.stringify(args, null, 2) + '\n')
  await ensureMock(paths)
  mkdirSync(ART, { recursive: true })
  writeFileSync(logPath, `# DS-BB-012 stage ${stage} — started ${new Date().toISOString()}\n# env: DSH_HOME=${HOME} DEEPSEEK_BASE_URL=http://127.0.0.1:${paths.mockPort}/v1\n\n`)

  const log = createWriteStream(logPath, { flags: 'a' })
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, [join(HERE, 'engine-stage.mjs'), stage, argsFile], {
      cwd: HERE,
      env: { ...process.env, DSH_HOME: HOME, MOCK_PORT: String(paths.mockPort) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.pipe(log)
    child.stderr.pipe(log)
    child.on('close', resolve)
  })
  log.end()
  const result = readJson(out)
  console.log(`[012] stage ${stage}: exit ${code} — ${result?.failed ? 'FAILED ' + result.error : 'ok'}`)
  return { code, result }
}

// Start the detached mock if the recorded port is not already answering. Safe to call
// before every engine stage: a live mock is left untouched, a dead one is re-spawned.
async function ensureMock(paths) {
  const already = await probePort(paths.mockPort)
  if (already) return
  const mock = spawn(process.execPath, [join(REPO, 'ds-bot', 'dev', 'mock-llm.mjs'), DATA], {
    cwd: join(REPO, 'ds-bot', 'dev'),
    env: { ...process.env, MOCK_PORT: String(paths.mockPort), MOCK_LOG, MOCK_DELAY_MS: '150', MOCK_JITTER_MS: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  })
  mock.unref()
  writeFileSync(join(DATA, 'mock.pid'), String(mock.pid) + '\n')
  const deadline = Date.now() + 15_000
  for (;;) {
    if (await probePort(paths.mockPort)) break
    if (Date.now() > deadline) throw new Error(`mock LLM not ready on port ${paths.mockPort} after 15s`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  console.log(`[012] restarted mock on 127.0.0.1:${paths.mockPort} (pid ${mock.pid})`)
}

async function probePort(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
}

// --- integrity -------------------------------------------------------------

function snapshot(sessionFile) {
  return snapshotArtifact(sessionFile, { zstdDecompressSync })
}

// The engine-stage create result records the artifact location the runtime itself resolved.
function sessionArtifactPath(stageCreate) {
  const location = stageCreate?.artifactLocation
  if (location?.path !== undefined) return location.path
  throw new Error('create stage did not report an artifact location')
}

// Compare two snapshots: every original frame byte-identical, prefix append-only,
// whole-file hash allowed to change (R-remap appends new frames).
// beforeSnap / afterSnap are snapshotArtifact records (with their per-frame raw hashes);
// beforeBytes / afterBytes are the raw bytes actually held at each point, so the prefix
// check compares the real original against the current file — never the file against itself.
function compareIntegrity(beforeSnap, afterSnap, beforeBytes, afterBytes) {
  const comparison = { beforeSize: beforeSnap.sizeBytes, afterSize: afterSnap.sizeBytes }
  comparison.appendOnlyPrefix = prefixRelation(beforeBytes, afterBytes)
  comparison.frameCountBefore = beforeSnap.frameCount
  comparison.frameCountAfter = afterSnap.frameCount
  comparison.appendedFrameCount = afterSnap.frameCount - beforeSnap.frameCount
  const original = beforeSnap.frames
  const covering = afterSnap.frameCount >= original.length
  comparison.originalFramesIdentical = covering && original.every((frame, index) =>
    afterSnap.frames[index]?.sha256Raw === frame.sha256Raw)
  comparison.mismatchedFrames = covering
    ? original.map((frame, index) => afterSnap.frames[index]?.sha256Raw === frame.sha256Raw ? null : index)
      .filter(index => index !== null)
    : original.map((_, index) => index)
  comparison.wholeFileHashChanged = beforeSnap.sha256Whole !== afterSnap.sha256Whole
  comparison.mtimeBefore = beforeSnap.mtimeMs
  comparison.mtimeAfter = afterSnap.mtimeMs
  comparison.mtimeUnchanged = beforeSnap.mtimeMs === afterSnap.mtimeMs
  comparison.beforeWholeSha = beforeSnap.sha256Whole
  comparison.afterWholeSha = afterSnap.sha256Whole
  return comparison
}

// --- stages ----------------------------------------------------------------

async function setup() {
  rmSync(DATA, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true })
  mkdirSync(OLD_DIR, { recursive: true })
  mkdirSync(NEW_DIR, { recursive: true })
  mkdirSync(ART, { recursive: true })
  const mockPort = await grabFreePort()
  writeFileSync(join(OLD_DIR, 'README.txt'), 'old team workspace fixture for DS-BB-012 (012-A)\n')
  writeFileSync(join(NEW_DIR, 'README.txt'), 'new team workspace fixture for DS-BB-012 (012-A)\n')
  recordPaths({ mockPort })

  // Start the existing mock LLM (bench-sanctioned; it never validates the key). Detached:
  // it outlives this setup process and is stopped by the finish stage.
  const mock = spawn(process.execPath, [join(REPO, 'ds-bot', 'dev', 'mock-llm.mjs'), DATA], {
    cwd: join(REPO, 'ds-bot', 'dev'),
    env: { ...process.env, MOCK_PORT: String(mockPort), MOCK_LOG, MOCK_DELAY_MS: '150', MOCK_JITTER_MS: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  })
  mock.unref()
  writeFileSync(join(DATA, 'mock.pid'), String(mock.pid) + '\n')
  // Ready when the models route answers.
  const deadline = Date.now() + 15_000
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${mockPort}/v1/models`)
      if (response.ok) break
    } catch {
      if (Date.now() > deadline) throw new Error(`mock LLM not ready after 15s (port ${mockPort})`)
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  console.log(`[012] 012-A setup done: home=${HOME} old=${OLD_DIR} new=${NEW_DIR} mock=127.0.0.1:${mockPort} pid=${mock.pid}`)
}

async function stageB() {
  const { code, result } = await runStage('create')
  if (code !== 0) return { code, result }
  const artifact = sessionArtifactPath(result)
  const before = snapshot(artifact)
  const beforePath = join(ART, 'integrity-before-remap.json')
  writeFileSync(beforePath, JSON.stringify({
    capturedAt: new Date().toISOString(),
    file: artifact,
    ...before,
  }, null, 2) + '\n')
  // A pristine byte copy of the baseline — the true prefix reference the R-remap must not
  // rewrite. 012-C and 012-D both append, so this remains the invariant original.
  copyFileSync(artifact, join(ART, 'integrity-before-remap.bin'))
  result.artifactPath = artifact
  result.integrityBefore = { file: artifact, sha256Whole: before.sha256Whole, sizeBytes: before.sizeBytes, frameCount: before.frameCount }
  writeFileSync(join(ART, 'stage-create.json'), JSON.stringify(result, null, 2) + '\n')
  return { code: 0, result }
}

async function stageC() {
  // The old workspace disappears: renamed away, not deleted (the scene is preserved).
  if (existsSync(OLD_DIR)) renameSync(OLD_DIR, `${OLD_DIR}.removed`)
  const { code, result } = await runStage('reproduce')
  // The failed 012-C turn appends its own turn/end {error} frame; snapshot it so the
  // 012-D remap comparison still measures against the pristine 012-B baseline.
  if (code === 0) {
    const createResult = readJson(join(ART, 'stage-create.json'))
    const artifact = createResult.artifactPath
    writeFileSync(join(ART, 'integrity-after-reproduce.json'), JSON.stringify({
      capturedAt: new Date().toISOString(),
      file: artifact,
      ...snapshot(artifact),
    }, null, 2) + '\n')
  }
  return { code, result }
}

async function stageD() {
  const { code, result } = await runStage('remap')
  if (code !== 0) return { code, result }
  const createResult = readJson(join(ART, 'stage-create.json'))
  const artifact = createResult.artifactPath
  const after = snapshot(artifact)
  const beforeRecord = readJson(join(ART, 'integrity-before-remap.json'))
  const beforeBytes = readAll(join(ART, 'integrity-before-remap.bin'))
  const comparison = compareIntegrity(beforeRecord, after, beforeBytes, readAll(artifact))
  writeFileSync(join(ART, 'integrity-after-remap.json'), JSON.stringify({
    capturedAt: new Date().toISOString(),
    file: artifact,
    ...after,
  }, null, 2) + '\n')
  writeFileSync(join(ART, 'integrity-comparison.json'), JSON.stringify({
    remapStage: result,
    comparison,
    note: 'The R-remap (and the failed 012-C turn before it) appends new zstd frames; the whole-file hash changes by design. The 012-B original frames must be byte-identical, and the pristine byte prefix must be unchanged.',
  }, null, 2) + '\n')
  result.integrity = comparison
  writeFileSync(join(ART, 'stage-remap.json'), JSON.stringify(result, null, 2) + '\n')
  return { code: 0, result }
}

async function stageE() {
  return await runStage('verify')
}

async function stageF() {
  return await runStage('turn')
}

async function stageG() {
  // 012-G: re-run the remap guard on an already-mapped session. The task's invariant is
  // FRAME-LEVEL: the original event frames stay byte-identical (append-only, never
  // rewritten) and no duplicate working-directory/change is appended. The engine adds its
  // own lifecycle frames (session/end-seed) on each resume, so the whole-file hash is
  // expected to change — that is not a guard defect.
  const createResult = readJson(join(ART, 'stage-create.json'))
  const artifact = createResult.artifactPath
  const pre = snapshot(artifact)
  const { code, result } = await runStage('idempotent')
  if (code !== 0) return { code, result }
  const post = snapshot(artifact)
  const originalFramesIdentical = post.frameCount >= pre.frameCount
    && pre.frames.every((frame, index) =>
      post.frames[index]?.sha256Raw === frame.sha256Raw
      && post.frames[index]?.start === frame.start)
  const comparison = {
    // No second remap: the guard makes no set() call and appends no working-directory/change.
    guardIsNoOp: result.setCallsMade === 0,
    noDuplicateChangeEvent: result.changeEventCount === 1,
    originalFramesIdentical,
    appendedFrameCount: post.frameCount - pre.frameCount,
    wholeFileHashChanged: pre.sha256Whole !== post.sha256Whole, // expected true (lifecycle frames)
    preWholeSha: pre.sha256Whole,
    postWholeSha: post.sha256Whole,
    preFrameCount: pre.frameCount,
    postFrameCount: post.frameCount,
  }
  writeFileSync(join(ART, 'integrity-idempotent.json'), JSON.stringify({
    capturedAt: new Date().toISOString(),
    file: artifact,
    pre,
    post,
    comparison,
  }, null, 2) + '\n')
  result.integrity = comparison
  writeFileSync(join(ART, 'stage-idempotent.json'), JSON.stringify(result, null, 2) + '\n')
  return { code: 0, result }
}

async function finish() {
  const paths = loadPaths()
  // Stop the mock and confirm the port is released.
  const pidLine = readFileSync(join(DATA, 'mock.pid'), 'utf8').trim()
  const released = { mockPid: Number(pidLine), port: paths.mockPort }
  try {
    process.kill(released.mockPid, 'SIGTERM')
  } catch {
    released.killNote = 'process already gone'
  }
  await new Promise(resolve => setTimeout(resolve, 500))
  let probe
  try {
    await fetch(`http://127.0.0.1:${paths.mockPort}/v1/models`, { signal: AbortSignal.timeout(1500) })
    probe = 'still answering — mock did not stop'
  } catch {
    probe = 'port no longer answering — mock released'
  }
  released.portProbe = probe
  copyFileSync(MOCK_LOG, join(ART, 'mock-requests.jsonl'))
  writeFileSync(join(ART, 'process-cleanup.json'), JSON.stringify(released, null, 2) + '\n')
  console.log(`[012] finish: ${probe}`)
}

// --- entry ------------------------------------------------------------------

const ORDER = ['b', 'c', 'd', 'e', 'f', 'g']
const RUNNERS = {
  setup, b: stageB, c: stageC, d: stageD, e: stageE, f: stageF, g: stageG, finish,
}

async function main() {
  const sequence = stageArg === 'all' ? ['setup', ...ORDER, 'finish'] : [stageArg]
  if (!RUNNERS[sequence[0]]) throw new Error(`unknown stage ${sequence[0]}`)
  const summary = { task: 'DS-BB-012', startedAt: new Date().toISOString(), stages: {} }
  for (const name of sequence) {
    const outcome = await RUNNERS[name]()
    summary.stages[name] = {
      ...(name === 'setup' || name === 'finish' ? { ok: true } : {
        ok: outcome.code === 0,
        exit: outcome.code,
        result: outcome.result,
      }),
    }
    if ((name !== 'setup' && name !== 'finish') && outcome.code !== 0) {
      // Preserve the failure scene: no teardown, no further stages. The report records
      // where it stopped and what the actual (not force-fit) behavior was.
      writeSummary(summary)
      console.error(`[012] stage ${name} failed (exit ${outcome.code}); stopping, scene preserved.`)
      process.exitCode = 1
      return
    }
  }
  writeSummary(summary)
  console.log('[012] all requested stages completed')
}

function writeSummary(summary) {
  summary.finishedAt = new Date().toISOString()
  writeFileSync(join(ART, 'results.json'), JSON.stringify(summary, null, 2) + '\n')
}

main().catch(error => {
  console.error('[012] orchestrator failed:', error)
  process.exitCode = 1
})
