// 013-F: the old DS Bot's data folders are discoverable migration sources, offered on the import
// card, read-only for this app. The user's own DSH is preferred (DS-BB-011); the old default
// home folder and the custom folder an old install saved are both found; neither is ever set
// as this product's active data. The home, the DSH home and the shell data are throwaway
// folders, so the test never touches the user's own.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { app, paths } from './helpers/fake-electron.mjs'
import { installHooks } from './helpers/register.mjs'

const home = mkdtempSync(join(tmpdir(), 'ds-bot-first-run-'))
process.env.HOME = home
process.env.USERPROFILE = home
delete process.env.DS_BOT_HOME
delete process.env.DS_BOT_WORKSPACE
// The old install's shell data: the fake app keeps appData under its own throwaway root.
const oldShell = join(paths.root, 'appData', 'DS Bot')
const oldTeamSource = { dataDir: join(home, 'OldBotData') }

await installHooks()
const fr = await import('../src/first-run.mjs')

/** A minimal Bot team in a DSH home folder, the way findTeam recognises one. */
const team = (dir) => {
  mkdirSync(join(dir, 'bot'), { recursive: true })
  writeFileSync(join(dir, 'bot', 'state.json'), JSON.stringify({ bots: { b1: { id: 'b1', name: 'Chief', sessionId: 's1' } }, rooms: {} }))
}

const emptyDsh = join(home, 'dsh-empty')
const newDefault = fr.defaultPlaces()

test('the new data places are the new product\'s own, not the old ones', () => {
  assert.deepEqual(newDefault, { dataDir: join(home, '.ds-bot-base'), workspace: join(home, 'DS Bot Base') })
})

test('the old default data folder is discovered and offered, and is not adopted', () => {
  const oldDefault = join(home, '.ds-bot')
  team(oldDefault)
  process.env.DSH_HOME = emptyDsh

  const places = fr.chooseLocations()
  assert.equal(places.dataDir, newDefault.dataDir, 'the active data is the new default, not the old folder')
  assert.equal(places.workspace, newDefault.workspace)
  assert.equal(places.offer?.from, oldDefault, 'the offer names the old folder as its source')
  assert.equal(existsSync(join(paths.userData, 'locations.json')), false, 'the places wait for the import card\'s answer')
  // Read-only: the old folder gained nothing, and still holds its one file only.
  assert.deepEqual(readdirSync(join(oldDefault, 'bot')).sort(), ['state.json'])
  assert.equal(JSON.parse(readFileSync(join(oldDefault, 'bot', 'state.json'), 'utf8')).bots.b1.name, 'Chief')
})

test('the old install\'s custom data folder is discovered through its locations file', () => {
  rmSync(join(home, '.ds-bot'), { recursive: true, force: true }, ) // the default\'s team is the other test\'s
  team(oldTeamSource.dataDir)
  mkdirSync(oldShell, { recursive: true })
  writeFileSync(join(oldShell, 'locations.json'), JSON.stringify(oldTeamSource))
  process.env.DSH_HOME = emptyDsh

  const sources = fr.oldTeamSources()
  assert.ok(sources.includes(resolve(join(home, '.ds-bot'))), 'the old default is always a candidate')
  assert.ok(sources.includes(resolve(oldTeamSource.dataDir)), 'the old custom folder is a candidate')
  assert.equal(new Set(sources).size, sources.length, 'each source once')

  const places = fr.chooseLocations()
  assert.equal(places.dataDir, newDefault.dataDir)
  assert.equal(places.offer?.from, oldTeamSource.dataDir, 'the offer names the custom folder')
  assert.equal(existsSync(join(paths.userData, 'locations.json')), false)
})

test('the user\'s own DSH is preferred over the old folders', () => {
  const dsh = join(home, 'dsh')
  team(dsh)
  process.env.DSH_HOME = dsh

  assert.equal(fr.chooseLocations().offer?.from, dsh, 'the user\'s own DSH wins over the old DS Bot folders')
  assert.equal(existsSync(join(paths.userData, 'locations.json')), false, 'an offer keeps the run open, as the import card answers it')
})

test('a first run with nothing to offer keeps the new places and saves them', () => {
  // Take away the offers the other tests left: no DSH team, no old DS Bot team.
  delete process.env.DSH_HOME
  rmSync(join(home, '.ds-bot'), { recursive: true, force: true })
  rmSync(oldShell, { recursive: true, force: true })

  const places = fr.chooseLocations()
  assert.equal(places.dataDir, newDefault.dataDir)
  assert.equal(places.workspace, newDefault.workspace)
  assert.equal(places.offer, undefined)
  const saved = JSON.parse(readFileSync(join(paths.userData, 'locations.json'), 'utf8'))
  assert.equal(saved.dataDir, newDefault.dataDir, 'the saved places are the new product\'s own')
  assert.equal(saved.workspace, newDefault.workspace)
  // The old folders are never written, adopted or moved away.
  assert.equal(JSON.parse(readFileSync(join(oldTeamSource.dataDir, 'bot', 'state.json'), 'utf8')).bots.b1.name, 'Chief')
  assert.equal(fr.chooseLocations().dataDir, newDefault.dataDir, 'the next start reads the new places back')
})
