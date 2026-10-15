import '../shared/theme.css'
import './style.css'
import { CSPProvider } from '@base-ui/react/csp-provider'
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import type { CompatibilityChromeBridge, CompatibilityChromeCommand, CompatibilityChromeState } from '../../compatibility-chrome-contract.ts'
import { DesktopFrameTitlebarView } from '../../client/DesktopFrameTitlebarView.tsx'
import { en, zh } from '../../client/desktop-settings-locales.ts'
import { installChromeOverlay } from './overlay.ts'

declare global {
  interface Window { desktopChrome: CompatibilityChromeBridge }
}

const invoke = async (command: CompatibilityChromeCommand): Promise<void> => { await window.desktopChrome.invoke(command) }
const api = {
  openTerminal: () => invoke('terminal'),
  restart: () => invoke('restart'),
  restartToRecovery: () => invoke('restart-recovery'),
  reloadRenderer: () => invoke('reload'),
  toggleDeveloperTools: () => invoke('developer'),
  checkForUpdates: () => invoke('check-for-updates'),
}

export function Chrome() {
  const [state, setState] = useState<CompatibilityChromeState>()
  const [generation, setGeneration] = useState(0)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const off = window.desktopChrome.subscribe(setState)
    const dismiss = (): void => { setGeneration(value => value + 1) }
    const offDismiss = window.desktopChrome.onDismiss(dismiss)
    const offOverlay = installChromeOverlay(invoke, dismiss, () => { setFailed(true) })
    void window.desktopChrome.invoke('state').then(value => { if (value) setState(value) }).catch(() => { setFailed(true) })
    return () => { off(); offDismiss(); offOverlay() }
  }, [])
  useEffect(() => {
    document.documentElement.lang = state?.locale === 'zh' ? 'zh-CN' : 'en'
  }, [state?.locale])
  const copy = state?.locale === 'zh' ? zh : en
  // `-webkit-app-region: drag` cannot move a BrowserView, and it is worse than inert there: the
  // declaration suppresses the mouse events a JS drag needs, so the titlebar does not move at all.
  // Where the main process owns the drag, the declaration is neutralised and the gesture forwarded.
  const jsDrag = state?.jsDrag === true
  useEffect(() => {
    if (!jsDrag) return
    const style = document.createElement('style')
    style.setAttribute('data-dsh-js-drag', '')
    style.textContent = '.dshDesktopFrameTitlebar, .dshNativeFrame { -webkit-app-region: no-drag !important; }'
    document.head.append(style)
    console.log('[drag] jsDrag enabled, app-region overridden')
    return () => { style.remove() }
  }, [jsDrag])
  useEffect(() => {
    if (!jsDrag) return
    const diagnosing = true
    const onMouseDown = (event: MouseEvent): void => {
      if (event.button !== 0) return
      const target = event.target as Element | null
      const inBar = target !== null && target.closest('.dshDesktopFrameTitlebar, .dshNativeFrame') !== null
      if (diagnosing) console.log(`[drag] mousedown button=${String(event.button)} inBar=${String(inBar)} target=${target === null ? 'null' : target.tagName}`)
      if (target === null || !inBar) return
      if (target.closest('button, a, input, textarea, select, [role="button"], [role="menuitem"]') !== null) {
        if (diagnosing) console.log('[drag] ignored: interactive child')
        return
      }
      const bridge = window.desktopChrome as { beginDrag?: () => void } | undefined
      if (diagnosing) console.log(`[drag] calling beginDrag: ${typeof bridge?.beginDrag}`)
      bridge?.beginDrag?.()
    }
    const onRelease = (): void => { window.desktopChrome.endDrag() }
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('mouseup', onRelease, true)
    window.addEventListener('blur', onRelease)
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('mouseup', onRelease, true)
      window.removeEventListener('blur', onRelease)
    }
  }, [jsDrag])
  if (!state) return <header className="dshDesktopFrameTitlebar">DSH Desktop {failed && <span role="alert">{copy.operationFailed}</span>}</header>
  return <DesktopFrameTitlebarView
    key={generation}
    api={api}
    {...(state.remoteControl && !state.remoteControl.enabled ? { remoteControl: {
      seen: state.remoteControl.seen,
      open: () => invoke('remote-control'),
    } } : {})}
    t={key => copy[key]}
    environment={{ ...state, material: state.material !== 'off' && state.platform === 'darwin' ? 'transparent' : 'off' }}
    setMode={mode => mode === state.mode ? Promise.resolve() : invoke(`mode-${mode}`)}
  />
}

const root = document.getElementById('root')
if (root === null) throw new Error('dsh-desktop: missing chrome root')
createRoot(root).render(<CSPProvider disableStyleElements><Chrome /></CSPProvider>)
