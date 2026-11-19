// DS-BB-012 engine stage runner. Boots the pinned DSH runtime (0.2.2-rc.1, the exact packages
// the app ships) in-process from a scratch DSH_HOME and performs ONE named stage of the
// isolated validation. Every stage is its own process, so "restart the engine" (012-E) is a
// real cold boot against the same DSH_HOME.
//
//   node engine-stage.mjs <stage> <args.json>
//
// Stages:
//   create      012-B: mint the fixture session under the old (then existing) cwd; one mock turn
//   reproduce   012-C: old dir now missing; resume succeeds, the model turn fails (actual reason recorded)
//   remap       012-D: workingDirectory.set(agent, newDir) appends the working-directory/change
//   verify      012-E: cold boot; discovery + resume + workingDirectory.get/ensure on the new path
//   turn        012-F: one real model turn in the real engine, answered by the test mock
//   idempotent  012-G: a guard pass is a no-op on an already-mapped session; a control session
//                   in the new workspace is created and turned, untouched by the remap
//
// args file: { home, oldDir, newDir, mockPort, mockLog, out, sessionId, controlId }
// The stage writes its result JSON to <out>; its console log is captured by the orchestrator.
import { writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [stage, argsPath] = process.argv.slice(2)
if (!stage || !argsPath) {
  console.error('usage: node engine-stage.mjs <stage> <args.json>')
  process.exit(2)
}
const args = JSON.parse(readFileSync(argsPath, 'utf8'))
const { home, oldDir, newDir, mockPort, mockLog, out, sessionId, controlId } = args

// The pinned runtime the desktop app ships (011R audit baseline). Resolved relative to this
// file (<repo>/ds-bot/dev/dsbb012/), so nothing under the user's DSH_HOME is touched.
const HERE = dirname(fileURLToPath(import.meta.url)) // <repo>/ds-bot/dev/dsbb012
const REPO = join(dirname(dirname(dirname(HERE))))
// import() needs a file URL (a bare C:/... path is not a valid ESM specifier); the runtime
// path arguments keep the plain form.
const pkgImport = sub => pathToFileURL(join(REPO, 'app', 'node_modules', '@deepseek-ai', sub))
const pkg = sub => join(REPO, 'app', 'node_modules', '@deepseek-ai', sub)

process.env.DSH_HOME = home
process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${mockPort}/v1`
process.env.DEEPSEEK_API_KEY = 'sk-mock-dsbb012' // local mock only; the mock server never validates it
// The official telemetry opt-out (dsh-app-boot: any non-empty value disables the otel row).
process.env.DSH_TELEMETRY_DISABLED = '1'

// workingDirectory.get() returns the fs targetKey form (canonical), which is not string-equal
// to the raw newDir the orchestrator passes; compare through a canonical file-URL form.
const sameDir = (a, b) =>
  a !== null && a !== undefined &&
  pathToFileURL(resolvePath(a)).href === pathToFileURL(resolvePath(b)).href

const log = line => console.log(`[dsbb012:${stage}]`, line)

async function boot() {
  const appBoot = await import(pkgImport('dsh-app-boot/lib/index.js'))
  const dsh = await import(pkgImport('dsh/lib/profile-boot.js'))
  const profileDir = join(home, 'profiles', 'dsbb012')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-dsbb012',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2))
  // Overlay: keep the host services; drop the session-log upload row (dsh-base cordis row
  // "session-log-deepseek") so nothing is sent to a product service. Telemetry is off through
  // DSH_TELEMETRY_DISABLED above. No external business service is contacted by the run.
  writeFileSync(join(profileDir, 'cordis.patch.yml'), [
    '- id: session-log-deepseek',
    '  disabled: true',
  ].join('\n') + '\n')
  const environment = appBoot.loadLayeredEnv('dsh')
  const profile = appBoot.loadProfileDirectory('dsh', profileDir, join(REPO, 'app', 'package.json'))
  if (profile.skippedBundles.length > 0) log(`skipped bundles: ${JSON.stringify(profile.skippedBundles)}`)
  const running = await dsh.runProfile({
    environment,
    profile: 'dsbb012',
    resolvedProfile: { profile, installAnchor: join(REPO, 'app', 'package.json') },
    patchFiles: [],
    args: ['--no-open', '--port', '0'],
  })
  log('engine booted')
  return running
}

const whenIdle = (agent, ms = 90_000) => Promise.race([
  agent.whenIdle(),
  new Promise((_, reject) => setTimeout(() => reject(new Error(`agent did not go idle within ${ms}ms`)), ms)),
])

// The last turn/end in the stored log: its data records whether the turn completed or failed.
async function lastTurnEnd(ctx, id) {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    const { events } = await handle.read(0, undefined)
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'turn/end') return { ...events[i], eventsSoFar: i }
    }
    return undefined
  } finally {
    await handle.close()
  }
}

const readAll = async (ctx, id) => {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    return (await handle.read(0, undefined)).events
  } finally {
    await handle.close()
  }
}

const counts = events => {
  const tally = {}
  for (const event of events) tally[event.type] = (tally[event.type] ?? 0) + 1
  return tally
}

const mockCount = path => {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

let liveApp
async function run() {
  liveApp = await boot()
  const app = liveApp
  const { ctx } = app
  const result = { stage, startedAt: new Date().toISOString() }
  const controller = ctx.get('sessionController')
  const workingDirectory = ctx.get('workingDirectory')
  if (!controller || !workingDirectory) throw new Error(`engine services missing: controller=${!!controller} workingDirectory=${!!workingDirectory}`)

  const { createUserMessage } = await import(pkgImport('dsh-llm/lib/index.js'))

  // resolveAgent returns { agent } on success or { error } on a stable Session-domain failure.
  const resolve = async id => {
    const resolved = await controller.resolveAgent(id)
    if ('error' in resolved) throw new Error(`resolveAgent(${id}) failed: ${JSON.stringify(resolved.error)}`)
    return resolved.agent
  }

  switch (stage) {
    case 'create': {
      // 012-B: the fixture session, minted by the engine under the old (then existing) cwd.
      const created = await controller.create({ sessionId, cwd: oldDir })
      result.createdSessionId = created.sessionId
      const agent = await resolve(sessionId)
      log(`created session ${created.sessionId} under ${oldDir}`)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello, old workspace' }], source: { kind: 'user' } }))
      await whenIdle(agent)
      const events = await readAll(ctx, sessionId)
      result.eventTypes = counts(events)
      result.eventCount = events.length
      result.initialTurnEnd = (await lastTurnEnd(ctx, sessionId))?.data ?? null
      result.mockRequestLines = mockCount(mockLog)
      result.artifactLocation = (await ctx.sessionPersistence.stat(sessionId))?.location ?? null
      break
    }

    case 'reproduce': {
      // 012-C: the old directory no longer exists (the orchestrator removed it).
      result.oldDirExists = statDir(oldDir)
      result.listDiscovered = (await ctx.sessionPersistence.list()).some(snapshot => snapshot.header.id === sessionId)
      const agent = await resolve(sessionId)
      result.resumed = true
      // get() reads the committed directory with no fs I/O; it is keyed on the live session.
      result.getcwd = workingDirectory.get(agent.session)
      const preMock = mockCount(mockLog)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'ping after the old workspace vanished' }], source: { kind: 'user' } }))
      await whenIdle(agent)
      const turnEnd = await lastTurnEnd(ctx, sessionId)
      result.failingTurnEnd = turnEnd ? { seq: turnEnd.seq, data: turnEnd.data } : null
      result.mockRequestsDuringTurn = mockCount(mockLog) - preMock
      result.eventCountAfter = (await readAll(ctx, sessionId)).length
      break
    }

    case 'remap': {
      // 012-D: the R remap through the public service — one appended working-directory/change.
      const agent = await resolve(sessionId)
      const before = workingDirectory.get(agent.session)
      result.getcwdBefore = before
      result.setCallsMade = 0
      if (!sameDir(before, newDir)) {
        const mapped = await workingDirectory.set(agent, newDir)
        result.setCallsMade = 1
        result.remappedTo = mapped
      }
      const events = await readAll(ctx, sessionId)
      result.getcwdAfter = workingDirectory.get(agent.session)
      result.changeEvents = events.filter(event => event.type === 'working-directory/change')
        .map(event => ({ seq: event.seq, cwd: event.data.cwd }))
      result.noticeEvents = events.filter(event => event.type === 'user/message' && event.data?.source?.kind === 'working-directory')
        .map(event => ({ seq: event.seq, text: JSON.stringify(event.data.content).slice(0, 300) }))
      result.eventTypes = counts(events)
      break
    }

    case 'verify': {
      // 012-E: a cold engine on the same home; the mapping must have survived the restart.
      const list = await ctx.sessionPersistence.list()
      result.discovered = list.some(snapshot => snapshot.header.id === sessionId)
      result.listedSessionCount = list.length
      const stat = await ctx.sessionPersistence.stat(sessionId)
      result.statFormatStatus = stat?.formatStatus
      const agent = await resolve(sessionId)
      result.getcwdAfterRestart = workingDirectory.get(agent.session)
      const ensured = await workingDirectory.ensure(agent)
      result.ensureResult = ensured
      break
    }

    case 'turn': {
      // 012-F: the real engine completes one model turn in the resumed session, on the mock.
      const agent = await resolve(sessionId)
      const preEvents = await readAll(ctx, sessionId)
      const preMock = mockCount(mockLog)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'ping after the remap' }], source: { kind: 'user' } }))
      await whenIdle(agent)
      // Serialize only the fields each event type actually carries; assistant content lives
      // under data.message, user content under data.content, and turn/end carries data.reason.
      const clip = value => {
        const text = JSON.stringify(value)
        return text === undefined ? undefined : text.slice(0, 400)
      }
      const fresh = (await readAll(ctx, sessionId)).slice(preEvents.length)
      result.newEvents = fresh.map(event => ({
        seq: event.seq,
        type: event.type,
        ...(event.type === 'user/message' && event.data?.content !== undefined ? { content: clip(event.data.content) } : {}),
        ...(event.type === 'assistant/message' && event.data?.message?.content !== undefined ? { reply: clip(event.data.message.content) } : {}),
        ...(event.type === 'turn/end' ? { reason: event.data?.reason ?? event.data } : {}),
      }))
      result.mockRequestsDuringTurn = mockCount(mockLog) - preMock
      break
    }

    case 'idempotent': {
      // 012-G: the remap guard — a second remap of an already-mapped session is a no-op.
      const agent = await resolve(sessionId)
      const current = workingDirectory.get(agent.session)
      result.getcwd = current
      result.setCallsMade = 0
      if (!sameDir(current, newDir)) {
        await workingDirectory.set(agent, newDir)
        result.setCallsMade = 1
        await whenIdle(agent)
      }
      const events = await readAll(ctx, sessionId)
      result.changeEventCount = events.filter(event => event.type === 'working-directory/change').length
      // A control session in the NEW workspace: created and turned here; it must never be
      // touched by the remap guard, and must complete its own turn normally.
      await controller.create({ sessionId: controlId, cwd: newDir })
      const controlAgent = await resolve(controlId)
      controlAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'control: fresh session in the new workspace' }], source: { kind: 'user' } }))
      await whenIdle(controlAgent)
      result.controlTurnEnd = (await lastTurnEnd(ctx, controlId))?.data ?? null
      result.controlEventTypes = counts(await readAll(ctx, controlId))
      break
    }

    default:
      throw new Error(`unknown stage ${stage}`)
  }

  result.finishedAt = new Date().toISOString()
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n')
  log(`stage ${stage} wrote ${out}`)
  await app.shutdown.shutdown(0)
  log('engine shut down cleanly')
}

function statDir(dir) {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

run().catch(async error => {
  console.error(`[dsbb012:${stage}] FAILED:`, error)
  try {
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify({ stage, failed: true, error: error?.message ?? String(error), stack: error?.stack }, null, 2) + '\n')
  } catch { /* out not resolvable */ }
  // Release the engine so a failed stage never leaves a live process holding the session.
  try {
    if (liveApp) await liveApp.shutdown.shutdown(0)
  } catch { /* already disposed */ }
  process.exitCode = 1
})
