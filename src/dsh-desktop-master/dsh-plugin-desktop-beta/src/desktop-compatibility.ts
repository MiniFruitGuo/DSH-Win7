/** Windows-release gating for Desktop subsystems that need Windows 8 or newer. */

import { release } from 'node:os'

/**
 * Desktop subsystems whose availability is decided by the Windows release.
 *
 * Each id names a capability the product cannot provide on Windows 7 SP1
 * because the underlying binary imports an API the release does not export:
 * `terminal-pty` needs ConPTY (Windows 10 1809), `attachment-raster` loads
 * libvips (Windows 8 API set), `speech-to-text` loads onnxruntime (Windows 8
 * API set), and `office-pdf` spawns the Rust-built LibreOfficeKit helper
 * (Windows 8 API set). The settings page renders the ids it receives, so the
 * list stays the single source of truth for the user-visible downgrade.
 */
export type DesktopCompatibilityCapability =
  | 'terminal-pty'
  | 'attachment-raster'
  | 'speech-to-text'
  | 'office-pdf'

/** One gated subsystem and its live availability. */
export interface DesktopCompatibilityCapabilityView {
  /** Stable subsystem id the renderer maps to localized copy. */
  readonly id: DesktopCompatibilityCapability
  /** Whether the running host can provide the subsystem. */
  readonly available: boolean
}

/** Renderer-safe projection of the host platform and its release gating. */
export interface DesktopCompatibilityView {
  /** Host platform, so the renderer can word the notice without Electron access. */
  readonly platform: string
  /** Kernel release exactly as the OS reports it, for example `6.1.7601`. */
  readonly osRelease: string
  /** True on Windows releases before 8 (`6.2`), where every gated subsystem is unavailable. */
  readonly legacyWindows: boolean
  /** Every gated subsystem, in settings-page order. */
  readonly capabilities: readonly DesktopCompatibilityCapabilityView[]
}

/** Gated subsystems in the order the settings page lists them. */
const COMPATIBILITY_CAPABILITIES: readonly DesktopCompatibilityCapability[] = Object.freeze([
  'terminal-pty',
  'attachment-raster',
  'speech-to-text',
  'office-pdf',
])

/** First Windows release that exports the APIs these subsystems need. */
const FIRST_SUPPORTED_WINDOWS: readonly [number, number] = Object.freeze([6, 2])

/**
 * Split an `os.release()` value into its leading major and minor components.
 * @param value - Kernel release such as `6.1.7601` or `10.0.26200`.
 * @returns The parsed pair, or `undefined` when the value carries no dotted release.
 */
export function windowsRelease(value: string): readonly [number, number] | undefined {
  const match = /^(\d+)\.(\d+)/u.exec(value)
  if (match === null) return undefined
  const major = match[1]
  const minor = match[2]
  if (major === undefined || minor === undefined) return undefined
  return [Number(major), Number(minor)]
}

/**
 * Decide whether a host predates the first Windows release Desktop supports gated subsystems on.
 *
 * Only Windows below 8 is affected: `WaitOnAddress`/`WakeByAddress*` (Windows
 * 8), the `bcryptprimitives` API set (Windows 10 1903) and ConPTY (Windows 10
 * 1809) are imported by libuv, the Rust-built helpers and node-pty, so none of
 * them loads there. An unreadable release string counts as supported: the
 * result drives a user-visible downgrade notice, so a failed probe must never
 * invent one.
 * @param platform - Value of `process.platform`.
 * @param osRelease - Value of `os.release()`.
 * @returns True when the host is older than the first supported Windows release.
 */
export function isLegacyWindows(platform: string, osRelease: string): boolean {
  if (platform !== 'win32') return false
  const parts = windowsRelease(osRelease)
  if (parts === undefined) return false
  const supported = FIRST_SUPPORTED_WINDOWS
  if (parts[0] !== supported[0]) return parts[0] < supported[0]
  return parts[1] < supported[1]
}

/**
 * Project the running host's platform and capability state for the renderer.
 * @param runtime - Platform and release probe, injectable for tests.
 * @returns A frozen, renderer-safe compatibility projection.
 */
export function desktopCompatibility(
  runtime: { readonly platform: string; readonly osRelease: string } = {
    platform: process.platform,
    osRelease: release(),
  },
): DesktopCompatibilityView {
  const legacyWindows = isLegacyWindows(runtime.platform, runtime.osRelease)
  return Object.freeze({
    platform: runtime.platform,
    osRelease: runtime.osRelease,
    legacyWindows,
    capabilities: Object.freeze(COMPATIBILITY_CAPABILITIES.map(
      (id): DesktopCompatibilityCapabilityView => Object.freeze({ id, available: !legacyWindows }),
    )),
  })
}
