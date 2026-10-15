import { describe, expect, it } from 'vitest'
import {
  desktopCompatibility,
  isLegacyWindows,
  windowsRelease,
} from '../src/desktop-compatibility.ts'
import type { DesktopMarketSnapshot } from '../src/desktop-market.ts'
import DesktopSettingsController, { type DesktopSettingsControllerBootstrap } from '../src/desktop-settings-controller.ts'
import type { DesktopProfileSummary } from '../src/profile-manager.ts'
import { parseDesktopSettingsView } from '../src/client/desktop-settings-api.ts'

const WINDOWS_7 = { platform: 'win32', osRelease: '6.1.7601' } as const
const WINDOWS_10 = { platform: 'win32', osRelease: '10.0.26200' } as const

const GATED_CAPABILITIES = ['terminal-pty', 'attachment-raster', 'speech-to-text', 'office-pdf']

const BROWSER_AUTH_TOKEN = 'A'.repeat(43)

const DESKTOP: DesktopProfileSummary = {
  name: 'desktop',
  dir: '/private/profiles/desktop',
  exists: true,
  bundles: ['@deepseek-ai/dsh-web-app'],
  webCapable: true,
}

const VIEW = {
  aa: { requested: false, effective: false },
  current: 'desktop',
  profiles: [{
    name: 'desktop',
    exists: true,
    webCapable: true,
    selectable: true,
    deletable: false,
  }],
  market: { requested: 'disabled', effective: 'disabled', legacyDefaulted: false },
  web: {
    localUrl: `http://127.0.0.1:43120/?token=${BROWSER_AUTH_TOKEN}`,
    lanUrls: [],
    lanState: 'inactive',
    lanError: null,
    lanCaFingerprint: null,
    lanCaUrls: [],
  },
  compatibility: {
    platform: 'win32',
    osRelease: '6.1.7601',
    legacyWindows: true,
    capabilities: [
      { id: 'terminal-pty', available: false },
      { id: 'attachment-raster', available: false },
      { id: 'speech-to-text', available: false },
      { id: 'office-pdf', available: false },
    ],
  },
}

function market(): DesktopMarketSnapshot {
  return { requested: 'disabled', effective: 'disabled', legacyDefaulted: false }
}

function bootstrap(
  overrides: { readonly readCompatibility?: () => ReturnType<typeof desktopCompatibility> } = {},
): DesktopSettingsControllerBootstrap {
  return {
    readMarket: () => market(),
    readWeb: () => ({
      localUrl: 'http://127.0.0.1:43120/',
      lanUrls: [],
      lanState: 'inactive',
      lanError: null,
      lanCaFingerprint: null,
      lanCaUrls: [],
    }),
    selectMarket: async provider => ({ requested: provider, effective: 'disabled', legacyDefaulted: false }),
    scheduleRestart: () => {},
    scheduleRecoveryRestart: () => {},
    openTerminal: () => {},
    reloadRenderer: () => {},
    toggleDeveloperTools: () => {},
    exportDiagnostics: async () => {},
    ...overrides,
    profiles: {
      current: { name: DESKTOP.name, dir: DESKTOP.dir },
      list: () => [DESKTOP],
      create: () => DESKTOP,
      prepareSelection: async () => ({ restartRequired: false, restart: async () => {} }),
      canDelete: () => false,
      delete: async () => {},
    },
  }
}

describe('Windows release gating', () => {
  it('reads the leading major and minor of a kernel release', () => {
    expect(windowsRelease('6.1.7601')).toEqual([6, 1])
    expect(windowsRelease('10.0.26200')).toEqual([10, 0])
    expect(windowsRelease('')).toBeUndefined()
    expect(windowsRelease('win32')).toBeUndefined()
  })

  it('treats every Windows 7 release as legacy', () => {
    expect(isLegacyWindows('win32', '6.1.7601')).toBe(true)
    expect(isLegacyWindows('win32', '6.0.6002')).toBe(true)
  })

  it('accepts Windows 8 and later', () => {
    expect(isLegacyWindows('win32', '6.2.9200')).toBe(false)
    expect(isLegacyWindows('win32', '6.3.9600')).toBe(false)
    expect(isLegacyWindows('win32', '10.0.26200')).toBe(false)
  })

  it('never claims a downgrade it cannot prove', () => {
    expect(isLegacyWindows('darwin', '23.0.0')).toBe(false)
    expect(isLegacyWindows('linux', '6.1.0')).toBe(false)
    expect(isLegacyWindows('win32', '')).toBe(false)
    expect(isLegacyWindows('win32', 'unknown')).toBe(false)
  })

  it('projects every gated capability as unavailable on Windows 7 SP1', () => {
    const view = desktopCompatibility(WINDOWS_7)
    expect(view.legacyWindows).toBe(true)
    expect(view.capabilities.map(capability => capability.id)).toEqual(GATED_CAPABILITIES)
    expect(view.capabilities.every(capability => !capability.available)).toBe(true)
    expect(Object.isFrozen(view)).toBe(true)
    expect(Object.isFrozen(view.capabilities)).toBe(true)
  })

  it('projects every gated capability as available on Windows 10', () => {
    const view = desktopCompatibility(WINDOWS_10)
    expect(view.legacyWindows).toBe(false)
    expect(view.capabilities.map(capability => capability.id)).toEqual(GATED_CAPABILITIES)
    expect(view.capabilities.every(capability => capability.available)).toBe(true)
  })
})

describe('Desktop settings compatibility projection', () => {
  it('carries the injected platform state into the response', () => {
    const controller = new DesktopSettingsController(bootstrap({
      readCompatibility: () => desktopCompatibility(WINDOWS_7),
    }))
    const response = controller.read()
    expect(response.compatibility.legacyWindows).toBe(true)
    expect(response.compatibility.osRelease).toBe('6.1.7601')
    expect(response.compatibility.capabilities.every(capability => !capability.available)).toBe(true)
  })

  it('falls back to the running host when the launcher omits the probe', () => {
    const controller = new DesktopSettingsController(bootstrap())
    const response = controller.read()
    expect(response.compatibility.platform).toBe(process.platform)
    expect(response.compatibility.capabilities.map(capability => capability.id)).toEqual(GATED_CAPABILITIES)
  })
})

describe('Compatibility parsing in the renderer', () => {
  it('accepts a complete projection', () => {
    const parsed = parseDesktopSettingsView(VIEW)
    expect(parsed.compatibility).toEqual(VIEW.compatibility)
  })

  it('omits the projection when an older launcher does not send one', () => {
    const older: Record<string, unknown> = { ...VIEW }
    delete older.compatibility
    expect(parseDesktopSettingsView(older).compatibility).toBeUndefined()
  })

  it('rejects a half-read projection', () => {
    for (const compatibility of [
      {},
      { ...VIEW.compatibility, platform: '' },
      { ...VIEW.compatibility, legacyWindows: 'yes' },
      { ...VIEW.compatibility, capabilities: undefined },
      { ...VIEW.compatibility, capabilities: [{ id: 'terminal-pty' }] },
      { ...VIEW.compatibility, capabilities: [{ id: 'unknown-subsystem', available: false }] },
      {
        ...VIEW.compatibility,
        capabilities: [{ id: 'terminal-pty', available: false }, { id: 'terminal-pty', available: true }],
      },
      { ...VIEW.compatibility, capabilities: Array.from({ length: 17 }, () => ({ id: 'terminal-pty', available: false })) },
    ]) {
      expect(() => parseDesktopSettingsView({ ...VIEW, compatibility })).toThrow()
    }
  })
})
