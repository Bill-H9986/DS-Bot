// DS Bot Base's own identity. It is a new, independent product: a new appId, a new fixed
// installer GUID and its own data directory, so it installs, upgrades and uninstalls alongside
// the old DS Bot without either recognising the other as its update. The old product's
// directories are a migration source only, chosen by the user (first-run's import flow); this
// app never adopts them as its active data.
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const PRODUCT_NAME = 'DS Bot Base'
export const APP_ID = 'io.github.fei2411.dsbotbase'
// The directory that carries this product's own shell data, and thus what its Chromium
// OSCrypt identity is keyed on. Fixed for the life of the product: if the data folder is ever
// renamed, the captured identity is kept, not regenerated.
export const SHELL_DATA_DIR = 'DS-Bot-Base'
// The old DS Bot lineage (and its older DeepSeek Bot name), kept so released builds of the
// old product still find their own compatibility. This product never reuses their data.
export const LEGACY_PRODUCT_NAME = 'DeepSeek Bot'
export const LEGACY_ENGINE = 'deepseek-bot-engine'
export const LEGACY_ARTIFACT_PREFIX = 'DeepSeek-Bot'

/**
 * Point the app at its own, independent shell-data directory and keep the Chromium/OSCrypt
 * identity of an install that already has one stable. The old product's directories are never
 * adopted as this product's active data.
 * @returns {{ userData: string, upgrade: boolean }} `upgrade` is true once a launch finds this
 *   product's own data directory already holding a shell (an in-place start of an installed copy)
 *   rather than a first install.
 */
export function configureIdentity(app, { env = process.env, platform = process.platform, exists = existsSync, mkdir = mkdirSync } = {}) {
  const explicit = env.DS_BOT_SHELL_DATA
  // An explicitly isolated run (its own shell data or a throwaway data root) must never
  // discover an installed application.
  const isolated = explicit !== undefined || env.DS_BOT_HOME !== undefined
  // This product's own directory: %APPDATA%\DS-Bot-Base on Windows, its own application-data
  // folder elsewhere. It is set explicitly, not left to Electron's name-derived default, so the
  // new data root can never collide with the old product's folders.
  const userData = explicit || join(app.getPath('appData'), SHELL_DATA_DIR)
  // An in-place start of an installed copy: its own directory already exists with a shell, so
  // there is a keychain identity to keep. A first install has none yet, and so has nothing to
  // pin. Probed before the directory is created.
  const upgrade = !isolated && exists(userData)
  mkdir(userData, { recursive: true })
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
  if (platform === 'win32') app.setAppUserModelId(APP_ID)
  // Electron 44 captures the app name for Chromium's OSCrypt before ready. On a start of an
  // installed copy, the browser-encrypted data was written under this product's name, so pin
  // that name before ready and restore the visible name after, keeping the keychain identity
  // stable. Windows decrypts per-user via DPAPI rather than by name, so the capture is a no-op
  // there and is skipped.
  if (upgrade && platform !== 'win32') {
    app.setName(PRODUCT_NAME)
    app.once('ready', () => { app.setName(PRODUCT_NAME) })
  }
  return { userData, upgrade }
}
