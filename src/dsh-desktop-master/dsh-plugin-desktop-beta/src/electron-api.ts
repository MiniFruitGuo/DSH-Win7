/**
 * CommonJS bridge for the `electron` module.
 *
 * Electron publishes `electron` as a CommonJS module. Electron 28 and later add
 * ESM named-export interop for it, but Electron 22 — the last release that runs
 * on Windows 7 SP1 — does not. On that release `import { app } from 'electron'`
 * aborts with "Named export 'app' not found" before any product code runs, and
 * a CommonJS main entry is not an option either because this package's ESM-only
 * modules call `import.meta.resolve`.
 *
 * Loading the module through `createRequire` and re-exporting its members keeps
 * every consumer on a plain ESM import while reading the values from the
 * CommonJS object the runtime actually provides.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electron = require('electron') as typeof import('electron')

export const app = electron.app
export const BrowserView = electron.BrowserView
export const BrowserWindow = electron.BrowserWindow
export const contextBridge = electron.contextBridge
export const crashReporter = electron.crashReporter
export const dialog = electron.dialog
export const ipcMain = electron.ipcMain
export const ipcRenderer = electron.ipcRenderer
export const Menu = electron.Menu
export const nativeImage = electron.nativeImage
export const nativeTheme = electron.nativeTheme
export const net = electron.net
export const Notification = electron.Notification
export const safeStorage = electron.safeStorage
export const session = electron.session
export const shell = electron.shell
export const Tray = electron.Tray
export const utilityProcess = electron.utilityProcess
export const webUtils = electron.webUtils

/**
 * Electron 30 introduced `WebContentsView`; Electron 22 — the last release that
 * runs on Windows 7 SP1 — only ships `BrowserView`, whose surface is the same
 * one the product code uses (`webContents`, `setBounds`, `setBackgroundColor`)
 * and which attaches through `addBrowserView`. Exporting a single name keeps
 * the release difference in this module instead of at every call site.
 */
export const WebContentsView = ((electron as unknown as { WebContentsView?: unknown }).WebContentsView
  ?? electron.BrowserView) as typeof electron.WebContentsView

/**
 * `electron` declares these as classes, so consumers use the same name as both a
 * value and a type. Value and type live in separate namespaces, so re-exporting
 * both keeps `new BrowserWindow()` and `(win: BrowserWindow)` working from one
 * import site.
 */
export type BrowserView = Electron.BrowserView
export type BrowserWindow = Electron.BrowserWindow
export type Tray = Electron.Tray

/**
 * `screen` throws when read before the app is ready, so the lookup has to happen
 * per access instead of while this module initializes.
 */
export const screen: typeof electron.screen = new Proxy({} as typeof electron.screen, {
  get: (_target, key) => Reflect.get(electron.screen as object, key),
})
