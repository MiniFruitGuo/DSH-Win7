/**
 * The slice of `@deepseek-ai/dsh-app-boot` that the Electron main process needs.
 *
 * App Boot ships as a single 178 KB module whose top-level imports pull in the entire Cordis
 * composition engine — `@deepseek-ai/cordis`, `cordis-plugin-loader` and `cordis-plugin-group`.
 * The main process needs only a path helper, two filenames and a manifest reader/writer from it,
 * but `import { resolveProfileDir } from '@deepseek-ai/dsh-app-boot'` loads all of that into the
 * shell regardless.
 *
 * On Windows 7 the extra mapping is what pushes V8 off the address-space reservation it prefers and
 * into `EmulatedVirtualAddressSubspace`, whose page-accounting assertion aborts the whole process
 * (`v8/src/base/virtual-address-space.cc`, containing the exception `0x80000003`) at a different
 * point of every run. Keeping these few implementations in the shell means the engine is loaded
 * only where it does its work: the Host process, which already runs on the bundled Node runtime.
 *
 * The values and the file operations below are the upstream ones, copied verbatim; keep them in
 * step when the package changes. Types come from the package as type-only imports, which cost
 * nothing at runtime.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Directory under the Harness home holding every profile. */
export const PROFILES_DIR = 'profiles'

/** The user patch layer inside a profile directory (hot-reloaded on long-lived surfaces). */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** The shipped profile templates auto-initialized on first use, by name. */
export const PROFILE_TEMPLATES = {
  acp: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'] },
  web: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] },
  headless: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] },
  sdk: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'] },
  'sdk-minimal': { bundles: ['@deepseek-ai/dsh-sdk-minimal'] },
} as const

const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/**
 * Resolve a profile's directory under the Harness home.
 * @param name - the profile name (`dsh --profile <name>`).
 * @param home - the Harness home; defaults to the resolved DSH home.
 * @returns the absolute profile directory (which may not exist yet).
 */
export function resolveProfileDir(name: string, home: string = resolveDshHome()): string {
  if (name === '' || name.includes('/') || name.includes('\\') || name === '.' || name === '..' || name === 'node_modules') {
    throw new Error(`dsh: invalid profile name ${JSON.stringify(name)}`)
  }
  return join(home, PROFILES_DIR, name)
}

/** Read a profile's manifest (`package.json`) as a JSON object. */
export function readProfileManifest(binName: string, dir: string): ProfileManifest {
  const path = join(dir, 'package.json')
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`${binName}: failed to read profile manifest ${path}: ${String(error)}`)
  }
  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${binName}: profile manifest ${path} must hold a JSON object`)
  }
  return parsed as ProfileManifest
}

/** Write a profile's manifest back (2-space JSON, trailing newline). */
export function writeProfileManifest(dir: string, manifest: ProfileManifest): void {
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
}

/**
 * Initialize a profile directory: manifest, empty user patch layer, and the pnpm settings
 * out-of-tree plugins need. Existing files are never touched, so re-running is a no-op on an
 * initialized profile.
 */
export function initProfile(dir: string, bundles: readonly string[]): void {
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) {
    const manifest = {
      name: `dsh-profile-${basename(dir)}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...bundles] } },
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
  }
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  if (!existsSync(patchPath)) writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE)
  const workspacePath = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) writeFileSync(workspacePath, PROFILE_PNPM_WORKSPACE)
}
