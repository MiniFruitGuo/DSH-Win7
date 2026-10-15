import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const stableRoot = join(root, 'dsh-plugin-desktop', 'src')
const betaRoot = join(root, 'dsh-plugin-desktop-beta', 'src')
// Both editions now pin one core API. Only their product identities differ.
const allowedDifferences = new Set(['product-identity.ts'])
const normalizeIdentity = source => source.toString().replaceAll('dsh-plugin-desktop-beta', 'dsh-plugin-desktop').replaceAll('DSH Desktop Beta', 'DSH Desktop')
// Windows 7 build payloads, relative to each edition's package root. Both
// editions' `scripts/verify-packaged-runtime.ts` resolve them through the shared
// `installWindows7Ripgrep`, `installWindows7ReflinkShim` and
// `installWindows7PnpmLauncher` hooks, and the shared packaged-runtime test reads
// `build/pnpm-launcher/pnpm.exe` directly, so neither edition may ship its own
// divergent binary. Beta is the delivery-side source of truth for these files;
// Stable carries byte-identical copies.
const buildPayloads = [
  'build/ripgrep/rg.exe',
  'build/reflink/binding.js',
  'build/pnpm-launcher/pnpm.c',
  'build/pnpm-launcher/pnpm.exe',
  'build/pnpm-launcher/pnpm.obj',
  // The Windows 7 launch wrapper and installer hooks ship in both editions and must stay identical:
  // the wrapper locates the shell by pattern rather than by name precisely so one file can serve both.
  'build/win7-launch-recovery.cmd',
  'build/installer.nsh',
]
const stablePackageRoot = dirname(stableRoot)
const betaPackageRoot = dirname(betaRoot)
const sha256 = source => createHash('sha256').update(source).digest('hex')

function files(directory, base = directory) {
  const result = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...files(path, base))
    else if (entry.isFile()) result.push(relative(base, path).split(sep).join('/'))
  }
  return result
}

const sharedPaths = new Set([...files(stableRoot), ...files(betaRoot)])
const differences = []
for (const path of [...sharedPaths].sort()) {
  if (allowedDifferences.has(path)) continue
  let stable
  let beta
  try { stable = readFileSync(join(stableRoot, path)) } catch { stable = undefined }
  try { beta = readFileSync(join(betaRoot, path)) } catch { beta = undefined }
  if (stable === undefined || beta === undefined || normalizeIdentity(stable) !== normalizeIdentity(beta)) differences.push(path)
}

function payloadDigest(packageRoot, path) {
  try {
    const file = join(packageRoot, path)
    return statSync(file).isFile() ? sha256(readFileSync(file)) : undefined
  } catch {
    return undefined
  }
}

const payloadDrift = []
for (const path of buildPayloads) {
  const stable = payloadDigest(stablePackageRoot, path)
  const beta = payloadDigest(betaPackageRoot, path)
  if (stable === undefined || stable !== beta) payloadDrift.push({ path, stable, beta })
}

const payloadStatus = payloadDrift.length === 0
  ? `aligned; ${String(buildPayloads.length)} files match by SHA256 in both editions`
  : 'drifted; the offending payloads are listed below'

// State the payload verdict before any source-drift throw, so a run that fails
// on shared source still shows that the binary payload check executed.
if (differences.length > 0 || payloadDrift.length > 0) {
  process.stdout.write(`verify-desktop-variants: Windows 7 build payloads are ${payloadStatus}\n`)
}

if (differences.length > 0) {
  throw new Error(`Desktop variant source drift is not declared:\n${differences.map(path => `- src/${path}`).join('\n')}`)
}

if (payloadDrift.length > 0) {
  throw new Error(`Desktop variant Windows 7 build payload drift is not allowed:\n${payloadDrift.map(entry => `- ${entry.path}: dsh-plugin-desktop ${entry.stable ?? 'missing'} vs dsh-plugin-desktop-beta ${entry.beta ?? 'missing'}`).join('\n')}`)
}

process.stdout.write(`verify-desktop-variants: ${String(sharedPaths.size - allowedDifferences.size)} shared source files are aligned; both editions use isolated Host and chrome\n`)
process.stdout.write(`verify-desktop-variants: Windows 7 build payloads are ${payloadStatus}\n`)
