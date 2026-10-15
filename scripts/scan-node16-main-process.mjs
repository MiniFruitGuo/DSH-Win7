// Fail when the packaged main process cannot load on the Node 16 that Electron 22 embeds.
//
// The Windows 7 shell is Electron 22, which embeds Node 16 while the DSH packages target Node 22.
// A single missing named export (`util.parseEnv`, `zlib.createZstdCompress`, `module.findPackageJSON`,
// …) aborts ESM instantiation of the entire main process — and because that process is a GUI
// subsystem binary, the failure reaches no console: the window simply never appears. This gate turns
// that silent class of defect into a non-zero exit.
//
// The runtime must be a real Node 16 binary. Electron's `ELECTRON_RUN_AS_NODE` mode starts Electron's
// worker init and cannot execute ES modules at all (`activateUvLoop is not a function`), so it can
// only run CommonJS — useless for checking an ESM package tree.
//
// Usage:
//   node scripts/scan-node16-main-process.mjs <win-unpacked|app-dir> [--node16 <node.exe>] [--json <out>] [--verbose]
//
// Without a runtime the gate reports SKIP and exits 0, so a machine that has no Node 16 does not read
// as a passing payload: the exit code is 0 but the summary line says SKIP.

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'

/** Named imports the entry shim installs itself, so their absence in Node 16 is expected. */
const SHIM_INSTALLS_GLOBALS = /installNode16Globals/u

const NAMED_IMPORT = /import\s*\{([^}]*)\}\s*from\s*["'](node:[^"']+)["']/gsu
const SPECIFIER = /(?:from\s*|import\s*\(\s*)["']([^"']+)["']/gu

function parseArguments(argv) {
  const positional = []
  let json
  let node16
  let verbose = false
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--json') { json = argv[index + 1]; index += 1 } else if (value === '--node16') { node16 = argv[index + 1]; index += 1 } else if (value === '--verbose') verbose = true
    else positional.push(value)
  }
  return { target: positional[0], json, node16, verbose }
}

/** Accept either the assembled application directory or its parent `win-unpacked`. */
function resolveRoots(target) {
  const absolute = resolve(target)
  const applicationRoot = basename(absolute) === 'app' && basename(dirname(absolute)) === 'resources'
    ? absolute
    : join(absolute, 'resources', 'app')
  return { applicationRoot, outDir: basename(absolute) === 'app' ? resolve(absolute, '..', '..') : absolute }
}

/** A Node 16 binary from the explicit argument, the environment, or the repository fixtures. */
function resolveRuntime(explicit) {
  if (explicit !== undefined) return existsSync(explicit) ? explicit : undefined
  if (process.env.DSH_NODE16 !== undefined && existsSync(process.env.DSH_NODE16)) return process.env.DSH_NODE16
  const root = resolve(import.meta.dirname, '..', 'verify', 'n16')
  if (!existsSync(root)) return undefined
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = join(root, entry.name, 'node.exe')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function javascriptFiles(directory) {
  const stack = [directory]
  const files = []
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.isFile() && /\.(?:js|cjs|mjs)$/u.test(entry.name)) files.push(path)
    }
  }
  return files
}

/** Run one ES module on the target runtime from a real file. */
function runModule(runtime, source, args = [], cwd = undefined) {
  const scriptPath = join(cwd ?? tmpdir(), `dsh-node16-gate-${randomUUID()}.mjs`)
  writeFileSync(scriptPath, source)
  try {
    return spawnSync(runtime, [scriptPath, ...args], {
      encoding: 'utf8', cwd, timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
    })
  } finally {
    rmSync(scriptPath, { force: true })
  }
}

const { target, json, node16, verbose } = parseArguments(process.argv.slice(2))
if (target === undefined) {
  console.error('usage: node scripts/scan-node16-main-process.mjs <win-unpacked|app-dir> [--node16 <node.exe>] [--json <out>] [--verbose]')
  process.exit(2)
}

const { applicationRoot } = resolveRoots(target)
if (!existsSync(applicationRoot)) {
  console.error(`no packaged application at ${applicationRoot}`)
  process.exit(2)
}

const runtime = resolveRuntime(node16)
if (runtime === undefined) {
  console.log('scan-node16-main-process: SKIP — no Node 16 runtime (pass --node16 <node.exe> or set DSH_NODE16)')
  process.exit(0)
}
const runtimeVersion = spawnSync(runtime, ['--version'], { encoding: 'utf8' }).stdout.trim()

const probe = runModule(runtime, [
  'const { builtinModules } = await import("node:module")',
  'const out = {}',
  'for (const name of builtinModules) {',
  '  const id = name.startsWith("node:") ? name : "node:" + name',
  '  try { out[id] = Object.keys(await import(id)) } catch { out[id] = null }',
  '}',
  'process.stdout.write(JSON.stringify(out))',
  '',
].join('\n'))
if (probe.status !== 0 || probe.stdout.trim().length === 0) {
  console.error(`the chosen runtime ${runtime} could not enumerate builtins:\n${probe.stderr || probe.stdout}`)
  process.exit(2)
}
const builtins = JSON.parse(probe.stdout)

const entry = join(applicationRoot, 'lib', 'main-entry.cjs')
const entrySource = existsSync(entry) ? readFileSync(entry, 'utf8') : ''
const shimInstalled = SHIM_INSTALLS_GLOBALS.test(entrySource)

const chunks = javascriptFiles(join(applicationRoot, 'lib'))
const findings = []
const packages = new Set()
for (const file of chunks) {
  const source = readFileSync(file, 'utf8')
  for (const match of source.matchAll(NAMED_IMPORT)) {
    const specifier = match[2]
    const known = builtins[specifier]
    const wanted = (match[1] ?? '')
      .split(',')
      .map(part => part.trim().split(/\s+as\s+/u)[0]?.trim())
      .filter(name => name !== undefined && name.length > 0 && name !== 'type')
    if (known === undefined || known === null) {
      findings.push({ file, specifier, missing: ['<module not importable>'] })
      continue
    }
    const missing = wanted.filter(name => !known.includes(name))
    if (missing.length > 0) findings.push({ file, specifier, missing })
  }
  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[1]
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) continue
    const parts = specifier.split('/')
    packages.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0])
  }
}

// Every external package the main process imports must load on the shipping runtime. The probe sits
// inside the application root because ESM resolution is relative to the importing file.
const names = [...packages].sort().filter(name => existsSync(join(applicationRoot, 'node_modules', name)))
const packageFailures = []
if (names.length > 0) {
  const result = runModule(runtime, [
    'for (const name of process.argv.slice(2)) {',
    '  try { await import(name); console.log(`OK   ${name}`) }',
    '  catch (error) { console.log(`FAIL ${name} :: ${String(error && error.message).split("\\n")[0]}`) }',
    '}',
    '',
  ].join('\n'), names, applicationRoot)
  for (const line of `${result.stdout ?? ''}${result.stderr ?? ''}`.split('\n')) {
    if (line.startsWith('OK   ')) { if (verbose) console.log(`  ok   ${line.slice(5)}`) } else if (line.startsWith('FAIL ')) {
      const [name, detail] = line.slice(5).split(' :: ')
      packageFailures.push({ package: name, detail: detail ?? '(no detail)' })
    }
  }
}

const report = {
  runtime,
  runtimeVersion,
  applicationRoot,
  entryShimInstalled: shimInstalled,
  chunks: chunks.length,
  packages: names.length,
  builtinFindings: findings.map(finding => ({
    file: relative(applicationRoot, finding.file).split('\\').join('/'),
    specifier: finding.specifier,
    missing: finding.missing,
  })),
  packageFailures,
}
if (json !== undefined) writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`)

console.log(`scan-node16-main-process: runtime ${runtimeVersion} (${runtime})`)
console.log(`scan-node16-main-process: application chunks ${chunks.length}, external packages ${names.length}`)
console.log(`scan-node16-main-process: entry shim installs Node 16 globals: ${shimInstalled ? 'yes' : 'NO'}`)

const blocking = findings.length > 0 || packageFailures.length > 0 || !shimInstalled
for (const finding of findings) {
  console.error(`  incompatible named import: ${relative(applicationRoot, finding.file)} -> ${finding.specifier} missing ${finding.missing.join(', ')}`)
}
for (const failure of packageFailures) {
  console.error(`  package cannot load: ${failure.package} -> ${failure.detail}`)
}
if (!shimInstalled) console.error('  the main entry is missing the Node 16 global shim (scripts/emit-main-entry.mjs)')
console.log(blocking ? 'NODE16 MAIN PROCESS GATE: FAIL' : 'NODE16 MAIN PROCESS GATE: PASS')
process.exit(blocking ? 1 : 0)
