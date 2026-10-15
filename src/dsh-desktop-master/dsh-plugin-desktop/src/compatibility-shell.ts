import { BrowserView, ipcMain, screen, WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { COMPATIBILITY_CHROME_CHANNEL, COMPATIBILITY_CHROME_DRAG_CHANNEL, COMPATIBILITY_CHROME_STATE, type CompatibilityChromeState } from './compatibility-chrome-contract.ts'
import type { DesktopRendererActionHandlers } from './renderer-actions-dispatch.ts'
import type { DesktopLocale, DesktopPlatform, DesktopShellSpec } from './runtime.ts'
import { DESKTOP_FRAME_HEIGHT } from './window-chrome.ts'
import { DESKTOP_RENDERER_SESSION_PARTITION } from './window-options.ts'

export interface CompatibilityShellActions extends DesktopRendererActionHandlers {
  locale(): DesktopLocale
  version: string
  remoteControl?: { read(): Promise<{ enabled: boolean; seen: boolean }>; open(): Promise<void> }
}

export class CompatibilityShell {
  readonly content: ShellView
  private readonly documentPath = fileURLToPath(new URL('./native-ui/compatibility-chrome.html', import.meta.url))
  private disposed = false
  private remoteControl: CompatibilityChromeState['remoteControl']
  readonly chromeView: ShellView
  private expanded = false
  private readonly chrome: WebContents
  private contentBounds: Electron.Rectangle | undefined
  private chromeBounds: Electron.Rectangle | undefined
  /** Cursor-follow timer for a titlebar drag on runtimes without CSS app-region support. */
  private dragTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly window: BrowserWindow,
    private readonly spec: DesktopShellSpec,
    private readonly platform: DesktopPlatform,
    preload: string,
    private readonly actions: CompatibilityShellActions,
  ) {
    this.chromeView = createShellView(window, {
      preload: fileURLToPath(new URL('./compatibility-preload.cjs', import.meta.url)),
      partition: 'dsh-desktop-compatibility-chrome',
      // `sandbox: false` is required for our preloads, not a relaxation made for convenience.
      //
      // A sandboxed preload may only `require('electron')`. Ours routes the `electron` import through
      // the CommonJS bridge in `electron-api.ts` — necessary because Electron 22 has no ESM named-export
      // interop for `electron` — and that bridge needs `node:module` and `node:url`. Under
      // `sandbox: true` the preload therefore fails to load entirely, which silently leaves
      // `window.desktopChrome` undefined: no titlebar drag, no chrome state, and a "reading
      // 'subscribe' of undefined" error in the frame. Isolation is unaffected — `contextIsolation`
      // stays on and `nodeIntegration` stays off, so the renderer still has no direct Node access.
      contextIsolation: true, nodeIntegration: false, sandbox: false, webSecurity: true,
    })
    this.chromeView.setBackgroundColor('#00000000')
    this.chrome = this.chromeView.webContents
    this.content = createShellView(window, {
      preload,
      partition: DESKTOP_RENDERER_SESSION_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      // See the chrome view above: the CommonJS `electron` bridge needs `node:module`/`node:url`, which
      // a sandboxed preload cannot use. `contextIsolation` and `nodeIntegration` still isolate the
      // renderer from Node.
      sandbox: false,
      webSecurity: true,
    })
    // Let the native window material show through the extended sidebar.
    // CSS transparency alone cannot cross an opaque view surface.
    if (spec.mode === 'extended' && spec.material !== 'off') {
      this.content.setBackgroundColor('#00000000')
    }
    const host = contentViewHost(window)
    host.addChildView(this.content)
    host.addChildView(this.chromeView)
    window.on('resize', this.resize)
    window.on('restore', this.reveal)
    window.on('show', this.reveal)
    window.on('enter-full-screen', this.resize)
    window.on('leave-full-screen', this.resize)
    window.on('closed', this.dispose)
    this.chrome.on('will-navigate', this.preventNavigation)
    this.chrome.on('will-redirect', this.preventNavigation)
    this.chrome.on('will-attach-webview', this.preventNavigation)
    this.chrome.setWindowOpenHandler(() => ({ action: 'deny' }))
    registerChromeSender(this.chrome, (event, command: unknown) => {
      if (this.disposed || event.sender !== this.chrome
        || event.senderFrame !== this.chrome.mainFrame
        || event.senderFrame.url !== pathToFileURL(this.documentPath).href) {
        throw new Error('dsh-plugin-desktop: untrusted chrome sender')
      }
      return this.command(command)
    })
    this.chrome.on('render-process-gone', this.collapse)
    this.chrome.on('did-start-loading', this.collapse)
    // The interface can open and still be inert — the model list stays empty and nothing can be sent —
    // when the frontend throws, and a renderer error is otherwise invisible from the outside. Opt-in,
    // diagnostic only.
    if (process.env.DSH_DESKTOP_RENDERER_CONSOLE === '1') {
      const relay = (view: ShellView, label: string): void => {
        view.webContents.on('console-message', (_event, level, message, line, sourceId) => {
          process.stderr.write(`[${label}:${String(level)}] ${message} (${String(sourceId)}:${String(line)})\n`)
        })
        view.webContents.on('preload-error', (_event, path, error) => {
          process.stderr.write(`[${label}:preload] ${String(path)}: ${String(error.message)}\n`)
        })
      }
      relay(this.content, 'content')
      relay(this.chromeView, 'chrome')
      // Ask the page itself which of the APIs the frontend needs are actually present, and — in the
      // same channel — whether the titlebar drag is wired up on this runtime.
      this.content.webContents.on('did-finish-load', () => {
        void this.content.webContents.executeJavaScript(`JSON.stringify({
          toSorted: typeof Array.prototype.toSorted,
          abortAny: typeof AbortSignal.any,
          withResolvers: typeof Promise.withResolvers,
          ua: navigator.userAgent,
        })`, true).then(
          value => { process.stderr.write(`[probe] ${String(value)}\n`) },
          cause => { process.stderr.write(`[probe] failed: ${String(cause)}\n`) },
        )
      })
      // The chrome frame is a separate view; its drag wiring is what the user is reporting on. It is
      // already loaded by the time this runs, so the check is deferred rather than event-driven.
      setTimeout(() => {
        const script = `(() => {
          try {
            const bar = document.querySelector('.dshDesktopFrameTitlebar') || document.querySelector('.dshNativeFrame');
            const style = bar ? getComputedStyle(bar) : null;
            return JSON.stringify({
              bridge: typeof window.desktopChrome,
              beginDrag: typeof (window.desktopChrome && window.desktopChrome.beginDrag),
              bar: bar ? bar.className : null,
              appRegion: style ? (style.getPropertyValue('-webkit-app-region') || style.webkitAppRegion || 'none') : null,
              jsDragStyle: document.querySelector('style[data-dsh-js-drag]') ? true : false,
            });
          } catch (cause) { return 'probe threw: ' + String(cause); }
        })()`
        this.chrome.executeJavaScript(script, true).then(
          (value: unknown) => { process.stderr.write(`[drag-probe] ${String(value)}\n`) },
          (cause: unknown) => { process.stderr.write(`[drag-probe] failed: ${String(cause)}\n`) },
        )
      }, 3000)
    }
    // `BrowserView` cannot honour `-webkit-app-region: drag` (only `WebContentsView` and a window's
    // own webContents can), and the Electron releases this product runs on have no `contentView`, so
    // the frame is a `BrowserView` there and the titlebar would not drag at all. The renderer signals
    // the start and the end over this channel and the window is moved here instead.
    if (!hostsChildViews(window)) {
      ipcMain.on(COMPATIBILITY_CHROME_DRAG_CHANNEL, (event, phase: unknown) => {
        if (process.env.DSH_DESKTOP_STARTUP_HEARTBEAT === '1') {
          process.stderr.write(`[drag] received ${String(phase)} from ${String(event.sender.id)} chrome=${String(this.chrome.id)} disposed=${String(this.disposed)}\n`)
        }
        if (this.disposed || event.sender !== this.chrome) return
        if (phase === 'begin') this.beginDrag()
        else this.endDrag()
      })
    }
    // The shell dies 1.6-1.7 seconds after startup with no Host RPC and no chrome command in that
    // window, which is exactly when the renderer finishes loading. If the renderer leaves first, the
    // main process aborts while handling it. Diagnostic only, opt-in.
    if (process.env.DSH_DESKTOP_STARTUP_HEARTBEAT === '1') {
      const note = (message: string): void => { process.stderr.write(`[activity] ${message}\n`) }
      this.chrome.on('render-process-gone', (_event, details) => {
        note(`chrome-render-gone reason=${String(details.reason)} exit=${String(details.exitCode)}`)
      })
      this.chrome.on('unresponsive', () => { note('chrome-unresponsive') })
      this.chrome.on('did-fail-load', (_event, code, description) => {
        note(`chrome-fail-load ${String(code)} ${String(description)}`)
      })
      this.chrome.on('did-finish-load', () => { note('chrome-finish-load') })
      this.content.webContents.on('render-process-gone', (_event, details) => {
        note(`content-render-gone reason=${String(details.reason)} exit=${String(details.exitCode)}`)
      })
      this.content.webContents.on('unresponsive', () => { note('content-unresponsive') })
      this.content.webContents.on('did-fail-load', (_event, code, description) => {
        note(`content-fail-load ${String(code)} ${String(description)}`)
      })
      this.content.webContents.on('did-finish-load', () => { note('content-finish-load') })
      this.content.webContents.on('did-start-navigation', (_event, url) => { note(`content-navigate ${String(url)}`) })
    }
    window.on('blur', this.dismiss)
    window.on('hide', this.dismiss)
    this.resize()
  }

  get webContents(): WebContents { return this.content.webContents }
  get chromeWebContents(): WebContents { return this.chrome }

  async load(): Promise<void> {
    await this.updateRemoteControl()
    await this.chrome.loadFile(this.documentPath)
  }

  refresh(): void {
    if (!this.disposed && !this.chrome.isDestroyed()) {
      this.chrome.send(COMPATIBILITY_CHROME_STATE, this.state())
    }
  }

  private async updateRemoteControl(): Promise<void> {
    try { this.remoteControl = await this.actions.remoteControl?.read() }
    catch { this.remoteControl = undefined }
  }

  private async openRemoteControl(): Promise<void> {
    if (!this.actions.remoteControl) return
    if (this.remoteControl) this.remoteControl = { ...this.remoteControl, seen: true }
    this.refresh()
    try { await this.actions.remoteControl.open() }
    finally { await this.updateRemoteControl(); this.refresh() }
  }

  private state(): CompatibilityChromeState {
    return {
      mode: this.spec.mode === 'extended' ? 'extended' : 'compatibility',
      locale: this.actions.locale(),
      version: this.actions.version,
      platform: this.platform,
      material: this.spec.material,
      // The frame is a BrowserView exactly when the runtime has no `contentView`, and that is also
      // when the CSS drag declaration has to give way to the main-process implementation.
      jsDrag: !hostsChildViews(this.window),
      ...(this.remoteControl ? { remoteControl: this.remoteControl } : {}),
    }
  }

  private readonly resize = (): void => {
    if (this.disposed || this.window.isDestroyed()) return
    if (this.platform === 'win32' && this.window.isMinimized()) return
    const [width = 0, height = 0] = this.window.getContentSize()
    // Minimize/restore can expose a transient empty client area. Retain the
    // last usable surface until restore/show supplies the real dimensions.
    if (this.platform === 'win32' && (width <= 0 || height <= DESKTOP_FRAME_HEIGHT)) return
    const contentBounds = { x: 0, y: DESKTOP_FRAME_HEIGHT, width, height: Math.max(0, height - DESKTOP_FRAME_HEIGHT) }
    const chromeBounds = { x: 0, y: 0, width, height: this.expanded ? height : Math.min(height, DESKTOP_FRAME_HEIGHT) }
    if (!sameBounds(this.contentBounds, contentBounds)) {
      this.content.setBounds(contentBounds)
      this.contentBounds = contentBounds
    }
    if (!sameBounds(this.chromeBounds, chromeBounds)) {
      this.chromeView.setBounds(chromeBounds)
      this.chromeBounds = chromeBounds
    }
  }

  /**
   * Lay out and repaint the embedded views when the window comes back.
   *
   * Each embedded view owns a compositor separate from the native window, so
   * Chromium stops drawing them while the window is minimized and the restored
   * frame can present a stale surface. resize() alone cannot cover that: it
   * deliberately skips minimized windows and the degenerate client area
   * Windows reports mid-restore, and its sameBounds guard makes it a no-op
   * whenever the window returns at the size it already had.
   *
   * This replaces `backgroundThrottling: false` on the content view. Electron
   * applies that flag to the whole window, so the entire frame kept drawing
   * and swapping frames while minimized and the renderer was never
   * backgrounded, which is also the state Chromium requires before it reclaims
   * renderer memory.
   */
  private readonly reveal = (): void => {
    if (this.disposed || this.window.isDestroyed() || this.window.isMinimized()) return
    this.resize()
    if (!this.chrome.isDestroyed()) this.chrome.invalidate()
    if (!this.content.webContents.isDestroyed()) this.content.webContents.invalidate()
  }

  private readonly preventNavigation = (event: Electron.Event): void => { event.preventDefault() }

  private readonly collapse = (): void => {
    this.expanded = false
    this.resize()
  }

  private readonly dismiss = (): void => {
    if (!this.disposed && !this.chrome.isDestroyed()) this.chrome.send('dsh-desktop:chrome-dismiss')
    this.collapse()
  }

  /**
   * Move the window by following the cursor until the drag ends.
   *
   * Called only where the frame is a `BrowserView`, which ignores `-webkit-app-region: drag`. The
   * window offset is taken from the cursor position at the start, so the window keeps the grab point
   * under the pointer. The cursor is polled rather than driven by `mousemove` because a drag leaves
   * the view as soon as the pointer crosses into another window.
   */
  private beginDrag(): void {
    this.endDrag()
    if (this.window.isDestroyed()) return
    const origin = this.window.getPosition()
    const [originX = 0, originY = 0] = origin
    const grab = screen.getCursorScreenPoint()
    const diagnosing = process.env.DSH_DESKTOP_STARTUP_HEARTBEAT === '1'
    if (diagnosing) {
      process.stderr.write(`[drag] begin origin=${originX},${originY} cursor=${grab.x},${grab.y} maximized=${String(this.window.isMaximized())} fullscreen=${String(this.window.isFullScreen())}\n`)
    }
    this.dragTimer = setInterval(() => {
      if (this.window.isDestroyed()) {
        this.endDrag()
        return
      }
      const cursor = screen.getCursorScreenPoint()
      const nextX = originX + (cursor.x - grab.x)
      const nextY = originY + (cursor.y - grab.y)
      if (diagnosing) process.stderr.write(`[drag] move cursor=${cursor.x},${cursor.y} -> ${nextX},${nextY}\n`)
      this.window.setPosition(nextX, nextY)
    }, 16)
    // Safety nets: a renderer that never reports the release, or a drag that outlives the window's
    // focus, must not leave the window attached to the pointer.
    this.window.once('blur', () => { this.endDrag() })
    setTimeout(() => { this.endDrag() }, 20_000)
  }

  private endDrag(): void {
    if (this.dragTimer === undefined) return
    clearInterval(this.dragTimer)
    this.dragTimer = undefined
  }

  private command(command: unknown): CompatibilityChromeState | undefined | Promise<void> {
    switch (command) {
      case 'state': return this.state()
      case 'remote-control': return this.openRemoteControl()
      case 'expand': this.expanded = true; this.resize(); return
      case 'collapse': this.collapse(); return
      case 'terminal': this.actions.openTerminal(); return
      case 'check-for-updates': return this.actions.checkForUpdates()
      case 'mode-compatibility': return this.spec.requestModeChange('compatibility')
      case 'mode-extended': return this.spec.requestModeChange('extended')
      case 'mode-advanced': return this.spec.requestModeChange('advanced')
      case 'restart': return this.actions.restart()
      case 'restart-recovery': return this.actions.restartToRecovery()
      case 'reload': this.actions.reload(); return
      case 'developer': this.actions.developerTools(); return
      default: throw new Error('dsh-plugin-desktop: unsupported chrome command')
    }
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    this.window.off('blur', this.dismiss)
    this.window.off('hide', this.dismiss)
    this.window.off('resize', this.resize)
    this.window.off('restore', this.reveal)
    this.window.off('show', this.reveal)
    this.window.off('enter-full-screen', this.resize)
    this.window.off('leave-full-screen', this.resize)
    this.window.off('closed', this.dispose)
    if (!this.chrome.isDestroyed()) {
      this.chrome.off('render-process-gone', this.collapse)
      this.chrome.off('did-start-loading', this.collapse)
      unregisterChromeSender(this.chrome)
      this.chrome.off('will-navigate', this.preventNavigation)
      this.chrome.off('will-redirect', this.preventNavigation)
      this.chrome.off('will-attach-webview', this.preventNavigation)
    }
    if (!this.window.isDestroyed()) {
      const host = contentViewHost(this.window)
      host.removeChildView(this.content)
      host.removeChildView(this.chromeView)
    }
    if (!this.chrome.isDestroyed()) this.chrome.close({ waitForBeforeUnload: false })
    if (!this.webContents.isDestroyed()) this.webContents.close({ waitForBeforeUnload: false })
  }
}

function sameBounds(previous: Electron.Rectangle | undefined, next: Electron.Rectangle): boolean {
  return previous !== undefined && previous.x === next.x && previous.y === next.y
    && previous.width === next.width && previous.height === next.height
}
type ChromeSender = (event: Electron.IpcMainInvokeEvent, command: unknown) => unknown

/**
 * The window surface the embedded views are mounted on.
 *
 * Electron 30 introduced `window.contentView` and its child-view list; Electron
 * 22 — the last release supporting Windows 7 SP1 — predates the View API, where
 * a `BrowserView` attaches straight to its window with `addBrowserView`. Both
 * paths keep the same stacking rule: the view added last draws on top, so the
 * chrome stays above the content.
 */
interface ContentViewHost {
  addChildView(view: ShellView): void
  removeChildView(view: ShellView): void
}

/**
 * One embedded view, in whichever flavour this Electron can host.
 *
 * Electron 30 introduced `BrowserWindow.contentView` and, with it, hosting a `WebContentsView` as a
 * child view. Electron 22 — the last release that supports Windows 7 SP1 — has `WebContentsView`
 * and `BrowserView`, but no `contentView`, and its `addBrowserView` accepts only a `BrowserView`:
 * handing it a `WebContentsView` fails argument conversion at index 0. Selecting the pair by
 * capability is what lets the same shell run on both.
 */
type ShellView = WebContentsView | BrowserView

/** Whether this Electron hosts child views through `BrowserWindow.contentView`. */
function hostsChildViews(window: BrowserWindow): boolean {
  return (window as unknown as { contentView?: unknown }).contentView !== undefined
}

function createShellView(window: BrowserWindow, webPreferences: Electron.WebPreferences): ShellView {
  return hostsChildViews(window)
    ? new WebContentsView({ webPreferences })
    : new BrowserView({ webPreferences })
}

function contentViewHost(window: BrowserWindow): ContentViewHost {
  const host = (window as unknown as { contentView?: ContentViewHost }).contentView
  if (host !== undefined) return host
  const legacy = window as unknown as {
    addBrowserView(view: BrowserView): void
    removeBrowserView(view: BrowserView): void
  }
  return {
    addChildView: view => { legacy.addBrowserView(view as BrowserView) },
    removeChildView: view => { legacy.removeBrowserView(view as BrowserView) },
  }
}

/**
 * The IPC surface the chrome channel is served from.
 *
 * Electron 23 added the per-sender `webContents.ipc`. Electron 22 only has the
 * process-wide `ipcMain`, and `ipcMain.handle` rejects a second handler for the
 * same channel, so the fallback multiplexes one global handler per channel and
 * dispatches on the calling sender's id. Concurrent windows therefore share a
 * handler while each keeps its own sender/frame/URL checks, which is what
 * actually decides whether a call is trusted.
 */
interface ChromeIpc {
  handle(channel: string, handler: ChromeSender): void
  removeHandler(channel: string): void
}

function chromeIpc(webContents: WebContents): ChromeIpc {
  return (webContents as unknown as { ipc?: ChromeIpc }).ipc ?? sharedChromeIpc(webContents)
}

interface SharedChannel {
  handlers: Map<number, ChromeSender>
  dispatch: ChromeSender
}

const sharedChannels = new Map<string, SharedChannel>()

function sharedChromeIpc(webContents: WebContents): ChromeIpc {
  const senderId = webContents.id
  return {
    handle(channel, handler) {
      let channelState = sharedChannels.get(channel)
      if (channelState === undefined) {
        channelState = {
          handlers: new Map(),
          dispatch: (event, command) => {
            const target = sharedChannels.get(channel)?.handlers.get(event.sender.id)
            if (target === undefined) throw new Error('dsh-plugin-desktop: untrusted chrome sender')
            return target(event, command)
          },
        }
        sharedChannels.set(channel, channelState)
        // The shell dies about 1.6 seconds after startup finishes, with no `[native]` marker in
        // that window — so the trigger is the renderer talking to the main process rather than a Host
        // RPC or a timer. This records each command the chrome sends. Diagnostic only, opt-in.
        if (process.env.DSH_DESKTOP_STARTUP_HEARTBEAT === '1') {
          const dispatch = channelState.dispatch
          ipcMain.handle(channel, (event, command) => {
            const kind = (command as { type?: unknown } | undefined)?.type
            process.stderr.write(`[activity] chrome:${typeof kind === 'string' ? kind : '?'}\n`)
            return dispatch(event, command)
          })
        } else {
          ipcMain.handle(channel, channelState.dispatch)
        }
      }
      channelState.handlers.set(senderId, handler)
    },
    removeHandler(channel) {
      const channelState = sharedChannels.get(channel)
      if (channelState === undefined || !channelState.handlers.delete(senderId)) return
      if (channelState.handlers.size > 0) return
      sharedChannels.delete(channel)
      ipcMain.removeHandler(channel)
    },
  }
}

function registerChromeSender(chrome: WebContents, dispatch: ChromeSender): void {
  chromeIpc(chrome).handle(COMPATIBILITY_CHROME_CHANNEL, dispatch)
}

function unregisterChromeSender(chrome: WebContents): void {
  chromeIpc(chrome).removeHandler(COMPATIBILITY_CHROME_CHANNEL)
}
