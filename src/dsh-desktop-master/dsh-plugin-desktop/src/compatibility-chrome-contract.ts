import type { DesktopLocale, DesktopPlatform } from './runtime.ts'

export const COMPATIBILITY_CHROME_CHANNEL = 'dsh-desktop:compatibility-chrome'
export const COMPATIBILITY_CHROME_STATE = 'dsh-desktop:compatibility-chrome-state'
/**
 * Window-drag channel, used where the CSS mechanism cannot work.
 *
 * `-webkit-app-region: drag` is honoured by `WebContentsView` and by a window's own webContents, but
 * not by `BrowserView` — and the Electron releases this product runs on have no `contentView`, so the
 * frame is a `BrowserView` there and the titlebar would simply not drag. The renderer signals the
 * start and the end, and the main process moves the window by following the cursor.
 */
export const COMPATIBILITY_CHROME_DRAG_CHANNEL = 'dsh-desktop:compatibility-chrome-drag'

export type CompatibilityChromeCommand = 'mode-compatibility' | 'state' | 'check-for-updates' | 'mode-extended' | 'mode-advanced' | 'terminal' | 'restart' | 'restart-recovery' | 'reload' | 'developer' | 'expand' | 'collapse' | 'remote-control'

export interface CompatibilityChromeState {
  readonly mode: 'compatibility' | 'extended'
  readonly locale: DesktopLocale
  readonly platform: DesktopPlatform
  readonly version: string
  readonly material: string
  readonly remoteControl?: { readonly enabled: boolean; readonly seen: boolean }
  /**
   * Whether the window must be moved by the main process rather than by CSS.
   *
   * `-webkit-app-region: drag` only works in a `WebContentsView` or in a window's own webContents.
   * Where the frame is a `BrowserView` the declaration is worse than useless: it suppresses the mouse
   * events a JS implementation needs, so the titlebar does not drag at all. When this is true the
   * renderer neutralises that declaration and drives the drag through {@link CompatibilityChromeBridge.beginDrag}.
   */
  readonly jsDrag?: boolean
}

export interface CompatibilityChromeBridge {
  invoke(command: CompatibilityChromeCommand): Promise<CompatibilityChromeState | undefined>
  onDismiss(listener: () => void): () => void
  subscribe(listener: (state: CompatibilityChromeState) => void): () => void
  /** Begin a titlebar drag: the main process follows the cursor until {@link endDrag}. */
  beginDrag(): void
  /** End a titlebar drag. Harmless when no drag is in progress. */
  endDrag(): void
}
