// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DesktopSettingsSection,
  WindowsCompatibilityNotice,
  type DesktopSettingsSectionProps,
  type WindowsCompatibilityNoticeProps,
} from '../src/client/DesktopSettingsSection.tsx'
import { en, zh, type DesktopSettingsLocaleKey } from '../src/client/desktop-settings-locales.ts'
import type { DesktopCompatibilityView } from '../src/client/desktop-settings-api.ts'

/** Gated subsystem ids in the order the launcher reports them. */
const CAPABILITY_IDS = ['terminal-pty', 'attachment-raster', 'speech-to-text', 'office-pdf'] as const

function compatibilityFor(legacyWindows: boolean): DesktopCompatibilityView {
  return {
    platform: 'win32',
    osRelease: legacyWindows ? '6.1.7601' : '10.0.26200',
    legacyWindows,
    capabilities: CAPABILITY_IDS.map(id => ({ id, available: !legacyWindows })),
  }
}

let root: Root | undefined
let container: HTMLDivElement | undefined

function scope(value: unknown) {
  const snapshot = { status: 'ready', writable: true, value }
  return { getSnapshot: () => snapshot, subscribe: () => () => {} }
}

function viewFor(legacyWindows: boolean) {
  return {
    aa: { requested: false, effective: false },
    current: 'desktop',
    profiles: [],
    market: { requested: 'disabled', effective: 'disabled', legacyDefaulted: false },
    web: {
      localUrl: '',
      lanUrls: [],
      lanState: 'inactive',
      lanError: null,
      lanCaFingerprint: null,
      lanCaUrls: [],
    },
    compatibility: compatibilityFor(legacyWindows),
  }
}

async function mount(view: unknown, dictionary: Record<DesktopSettingsLocaleKey, string> = zh): Promise<HTMLDivElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const props = {
    t: (key: DesktopSettingsLocaleKey) => dictionary[key],
    api: { read: async () => view },
    platform: 'win32',
    version: '2.0.17-beta.1',
    initialMode: 'compatibility',
    setMode: async () => {},
    desktopSettings: scope({
      mode: 'compatibility',
      openBrowser: false,
      networkExposure: 'loopback',
      windowsMaterial: 'off',
      macosMaterial: 'off',
    }),
    notificationSettings: scope({ enabled: false }),
  } as unknown as DesktopSettingsSectionProps
  await act(async () => { root!.render(createElement(DesktopSettingsSection, props)) })
  return container
}

function compatibilitySection(mounted: HTMLDivElement): HTMLElement | null {
  return mounted.querySelector<HTMLElement>('[aria-labelledby="dsh-desktop-windows-compat-title"]')
}

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = undefined
  container?.remove()
})

describe('Windows 7 compatibility notice', () => {
  it('lists every unavailable subsystem on Windows 7 SP1', async () => {
    const mounted = await mount(viewFor(true))
    const section = compatibilitySection(mounted)
    expect(section).not.toBeNull()
    const text = section!.textContent ?? ''
    for (const key of [
      'windowsCompatCapabilityTerminalPty',
      'windowsCompatCapabilityAttachmentRaster',
      'windowsCompatCapabilitySpeechToText',
      'windowsCompatCapabilityOfficePdf',
      'windowsCompatOfflineUpdates',
    ] as const) {
      expect(text).toContain(zh[key])
    }
    expect(section!.querySelectorAll('[role="listitem"]')).toHaveLength(4)
  })

  it('stays hidden on a supported Windows release', async () => {
    const mounted = await mount(viewFor(false))
    expect(compatibilitySection(mounted)).toBeNull()
  })

  it('stays hidden when the launcher omits the projection', async () => {
    const legacy = viewFor(true) as Record<string, unknown>
    delete legacy.compatibility
    const mounted = await mount(legacy)
    expect(compatibilitySection(mounted)).toBeNull()
  })

  it('renders the notice in the active locale', async () => {
    const mounted = await mount(viewFor(true), en)
    const text = compatibilitySection(mounted)?.textContent ?? ''
    expect(text).toContain(en.windowsCompatTitle)
    expect(text).toContain(en.windowsCompatCapabilityTerminalPty)
  })
})

describe('Windows 7 compatibility notice markup', () => {
  // The slot translator accepts every key the settings shell can ask for, which
  // is wider than this page's own dictionary.
  const translate = ((key: string): string => (en as Record<string, string>)[key] ?? key) as WindowsCompatibilityNoticeProps['t']

  it('states every gated subsystem for a Windows 7 host', () => {
    const markup = renderToStaticMarkup(createElement(WindowsCompatibilityNotice, {
      compatibility: compatibilityFor(true),
      t: translate,
    }))
    expect(markup).toContain('dsh-desktop-windows-compat-title')
    expect(markup.match(/role="listitem"/gu)).toHaveLength(CAPABILITY_IDS.length)
    for (const key of [
      'windowsCompatCapabilityTerminalPty',
      'windowsCompatCapabilityAttachmentRaster',
      'windowsCompatCapabilitySpeechToText',
      'windowsCompatCapabilityOfficePdf',
      'windowsCompatOfflineUpdates',
    ] as const) {
      expect(markup).toContain(en[key])
    }
  })

  it('emits nothing for a host that provides every subsystem', () => {
    expect(renderToStaticMarkup(createElement(WindowsCompatibilityNotice, {
      compatibility: compatibilityFor(false),
      t: translate,
    }))).toBe('')
  })
})
