// Static Windows 7 SP1 gate for the packaged desktop payload.
//
// Walks every PE image under a directory, reads its import table straight out of
// the image, and reports the APIs that do not exist on Windows 7 SP1. This turns
// the earlier hand-checked dumpbin runs into a repeatable gate over the whole
// payload.
//
// Findings are split three ways:
//   blockers   - imported by a binary the Windows 7 x64 product actually loads
//   accepted   - proven unreachable or already handled; each entry carries the
//                evidence and the mitigation, so the list stays reviewable
//   foreign    - arm64 binaries that an x64 installation never loads
//
// Usage:
//   node scripts/scan-win7-imports.mjs [root] [--json <out>] [--verbose]

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

/** APIs and DLLs absent from a stock Windows 7 SP1 (with KB2533623 applied). */
const RULES = [
  { id: 'api-ms-win-core-synch-l1-2-0', match: dll => /^api-ms-win-core-synch-l1-2-0\.dll$/i.test(dll), since: 'Win8', note: 'WaitOnAddress / WakeByAddress — Win8+ API set' },
  { id: 'api-ms-win-core-path-l1-1-0', match: dll => /^api-ms-win-core-path-l1-1-0\.dll$/i.test(dll), since: 'Win8', note: 'PathCch* string helpers — Win8+ API set' },
  { id: 'api-ms-win-core-file-l1-2-1', match: dll => /^api-ms-win-core-file-l1-2-1\.dll$/i.test(dll), since: 'Win10 1809', note: 'GetTempPath2W — Win10 1809+' },
  { id: 'bcryptprimitives', match: dll => /^bcryptprimitives\.dll$/i.test(dll), since: 'Win10 1903', note: 'ProcessPrng — rust 1.62+ default' },
  { id: 'WaitOnAddress', match: (dll, fn) => fn === 'WaitOnAddress', since: 'Win8', note: 'synchronization primitive' },
  { id: 'WakeByAddress', match: (dll, fn) => /^WakeByAddress(All|Single)$/.test(fn), since: 'Win8', note: 'synchronization primitive' },
  { id: 'GetSystemTimePreciseAsFileTime', match: (dll, fn) => fn === 'GetSystemTimePreciseAsFileTime', since: 'Win8', note: 'libuv UV_CLOCK_REALTIME source' },
  { id: 'SetThreadDescription', match: (dll, fn) => /^SetThreadDescription$/.test(fn), since: 'Win10 1607', note: 'thread naming' },
  { id: 'CreatePseudoConsole', match: (dll, fn) => /^CreatePseudoConsole$/.test(fn), since: 'Win10 1809', note: 'ConPTY — terminal only' },
  { id: 'ProcessPrng', match: (dll, fn) => fn === 'ProcessPrng', since: 'Win10 1903', note: 'bcryptprimitives export' },
  { id: 'CopyFile2', match: (dll, fn) => fn === 'CopyFile2', since: 'Win8', note: 'file copy' },
  { id: 'GetThreadDescription', match: (dll, fn) => fn === 'GetThreadDescription', since: 'Win10 1607', note: 'thread naming' },
]

/**
 * Reviewed findings. Each entry states why the import cannot block a Windows 7
 * x64 boot and what the product does instead.
 */
const ACCEPTED = [
  {
    id: 'conpty',
    paths: /node-pty[\\/].*(conpty|OpenConsole\.exe)/i,
    evidence: [
      'ConPTY does not exist before Windows 10 1809.',
      'dsh-subprocess-local reaches node-pty only through `createLazyRequire("node-pty", ...)`',
      '(node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js:1261) and calls it from',
      '`openTerminal` (line 1450), so nothing on the boot path loads it.',
      'The Desktop shell does not use in-process PTYs at all: desktop-terminal.ts spawns',
      '`<bundled node> --expose-internals <desktop-cli.js>` with raw pipes.',
    ],
    outcome: 'Terminal panes are unavailable on Windows 7; the rest of the product is unaffected.',
  },
  {
    id: 'sharp-libvips',
    paths: /@img[\\/]sharp-win32-x64[\\/]lib[\\/]libvips-42\.dll$/i,
    evidence: [
      'dsh-attachment-local loads it through `createLazyRequire("sharp", ...)`',
      '(node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js:118); every call site',
      'either runs inside the surrounding try/catch ("INVALID_IMAGE") or is reached only',
      'while rasterizing an attachment.',
    ],
    outcome: 'Raster attachments (image resize/metadata) are unavailable on Windows 7; boot and text sessions are unaffected.',
  },
  {
    id: 'sherpa-onnx',
    paths: /sherpa-onnx-win-x64[\\/]onnxruntime\.dll$/i,
    evidence: [
      'Loaded inside the speech worker process only, from createTranscriber',
      '(node_modules/@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/lib/worker.js:74),',
      'which the experimental speech feature starts when a recording begins.',
    ],
    outcome: 'Speech-to-text is unavailable on Windows 7; the feature is experimental and off the boot path.',
  },
  {
    id: 'reflink',
    paths: /@reflink[\\/]/i,
    evidence: [
      'pnpm requires @reflink/reflink lazily inside `createCloneFunction()`',
      '(pnpm/dist/pnpm.mjs:160285, platform-gated to darwin/win32) so the napi-rs loader',
      'only throws once a clone importer is constructed. Measured with the complete',
      'win32-x64 prebuild tree removed, `pnpm install` of registry packages still',
      'succeeds through the hardlink importer.',
      'The afterPack hook still replaces the loader with `build/reflink/binding.js`',
      '(installWindows7ReflinkShim) so a store configuration that does pick clone',
      'degrades to fs.copyFileSync instead of aborting the process.',
    ],
    outcome: 'Dependency installs keep working; clone-style imports degrade to whole-file copies.',
  },
  {
    id: 'pnpm-uv',
    paths: /@dataiku[\\/]uv-win32-x64/i,
    evidence: [
      'Nothing under the packaged application imports `@dataiku/uv`: the desktop lib,',
      'the desktop package.json and every @deepseek-ai package were searched for the',
      'specifier and the binary name.',
    ],
    outcome: 'Unreferenced payload; remove it from the runtime to shrink the installer.',
  },
  {
    id: 'ripgrep-arm64',
    paths: /@vscode[\\/]ripgrep-win32-arm64/i,
    evidence: ['arm64 payload inside an x64 installation.'],
    outcome: 'Never loaded on Windows 7 x64.',
  },
  {
    id: 'libreoffice-kit',
    paths: /libreoffice-kit-win32-x64[\\/]bin[\\/]/i,
    evidence: [
      'LibreOfficeKit helper engine, spawned only for Office-to-PDF conversion.',
      'It is resolved by `resolveEngine()` (node_modules/@deepseek-ai/libreoffice-kit/lib/index.js:1260),',
      'which reads the package manifest and never launches the binary. The only launch site',
      '(`runNative`, index.js:582) attaches `child.once("error", ...)` and rejects with a',
      'ConversionError, so an unloadable helper degrades to a failed conversion.',
      'Its GetSystemTimePreciseAsFileTime arrives through the KERNEL32 import table (the rust std',
      'shape) rather than the api-ms-win-core-synch API set, so resolution depends on the exact',
      'kernel32 forwarder a Windows 7 build ships — only the target machine can prove that half.',
    ],
    outcome: 'Office-to-PDF conversion may be unavailable; document skills that avoid the engine still work.',
  },
]

/** arm64 images in an x64 payload are dead weight rather than blockers. */
const FOREIGN = /(win32-arm64|arm64-msvc|\.arm64\.node|darwin)/i

/** Reads a NUL-terminated ASCII string out of a buffer. */
function cstring(buffer, offset) {
  let end = offset
  while (end < buffer.length && buffer[end] !== 0) end += 1
  return buffer.toString('latin1', offset, end)
}

/** Parses one PE image's import table; returns null for non-PE input. */
export function readImports(buffer) {
  if (buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) return null
  const peOffset = buffer.readUInt32LE(0x3c)
  if (peOffset + 0x18 > buffer.length) throw new Error('truncated PE header')
  if (buffer.readUInt32LE(peOffset) !== 0x00004550) throw new Error('bad PE signature')

  const coff = peOffset + 4
  const machine = buffer.readUInt16LE(coff)
  const sectionCount = buffer.readUInt16LE(coff + 2)
  const optionalSize = buffer.readUInt16LE(coff + 16)
  const optional = coff + 20
  const magic = buffer.readUInt16LE(optional)
  const dirOffset = optional + (magic === 0x20b ? 0x70 : 0x60)
  const importRva = buffer.readUInt32LE(dirOffset + 8)

  const sections = []
  for (let index = 0; index < sectionCount; index += 1) {
    const base = optional + optionalSize + index * 40
    sections.push({
      name: cstring(buffer, base),
      virtualSize: buffer.readUInt32LE(base + 8),
      virtualAddress: buffer.readUInt32LE(base + 12),
      rawSize: buffer.readUInt32LE(base + 16),
      rawPointer: buffer.readUInt32LE(base + 20),
    })
  }
  const toOffset = rva => {
    for (const section of sections) {
      const size = Math.max(section.virtualSize, section.rawSize)
      if (rva >= section.virtualAddress && rva < section.virtualAddress + size) {
        return section.rawPointer + (rva - section.virtualAddress)
      }
    }
    return null
  }

  const imports = []
  if (importRva === 0) return { machine, imports }
  let descriptor = toOffset(importRva)
  if (descriptor === null) return { machine, imports }
  for (;;) {
    const originalFirstThunk = buffer.readUInt32LE(descriptor)
    const nameRva = buffer.readUInt32LE(descriptor + 12)
    const firstThunk = buffer.readUInt32LE(descriptor + 16)
    if (originalFirstThunk === 0 && nameRva === 0 && firstThunk === 0) break
    const nameOffset = toOffset(nameRva)
    const dll = nameOffset === null ? '<unnamed>' : cstring(buffer, nameOffset)
    let thunkOffset = toOffset(originalFirstThunk !== 0 ? originalFirstThunk : firstThunk)
    const functions = []
    if (thunkOffset !== null) {
      const width = machine === 0x8664 ? 8 : 4
      for (;;) {
        const value = width === 8
          ? Number(buffer.readBigUInt64LE(thunkOffset))
          : buffer.readUInt32LE(thunkOffset)
        if (value === 0) break
        const ordinalFlag = width === 8 ? 0x8000000000000000 : 0x80000000
        if ((BigInt(value) & BigInt(ordinalFlag)) !== 0n) {
          functions.push(`#${value & 0xffff}`)
        } else {
          const hintOffset = toOffset(value)
          if (hintOffset === null) break
          functions.push(cstring(buffer, hintOffset + 2))
        }
        thunkOffset += width
        if (functions.length > 20000) break
      }
    }
    imports.push({ dll, functions })
    descriptor += 20
    if (imports.length > 512) break
  }
  return { machine, imports }
}

const PE_EXTENSIONS = /\.(exe|dll|node|pyd)$/i

/** Scans one directory tree and classifies every Windows 8+ import. */
export function scanTree(root) {
  const census = { inspected: 0, pe: 0, notPe: 0, byMachine: {} }
  const findings = []
  const stack = [root]
  while (stack.length > 0) {
    const directory = stack.pop()
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        stack.push(path)
        continue
      }
      if (!entry.isFile()) continue
      census.inspected += 1
      if (!PE_EXTENSIONS.test(path)) continue
      let parsed
      try {
        parsed = readImports(readFileSync(path))
      } catch (cause) {
        findings.push({ kind: 'parse-error', path, detail: String(cause) })
        continue
      }
      if (parsed === null) {
        census.notPe += 1
        continue
      }
      census.pe += 1
      const machine = parsed.machine === 0x8664 ? 'x64' : parsed.machine === 0x14c ? 'x86' : `0x${parsed.machine.toString(16)}`
      census.byMachine[machine] = (census.byMachine[machine] ?? 0) + 1
      for (const entry2 of parsed.imports) {
        for (const rule of RULES) {
          const hits = entry2.functions.filter(fn => rule.match(entry2.dll, fn))
          const dllOnly = rule.match(entry2.dll, '')
          if (!dllOnly && hits.length === 0) continue
          const relativePath = relative(root, path).split('\\').join('/')
          findings.push({
            rule: rule.id,
            since: rule.since,
            note: rule.note,
            path,
            relativePath,
            machine,
            dll: entry2.dll,
            symbols: hits.slice(0, 6),
          })
        }
      }
    }
  }
  return { root, census, findings }
}

function classify(finding) {
  if (finding.kind === 'parse-error') return 'blockers'
  if (FOREIGN.test(finding.relativePath)) return 'foreign'
  for (const accepted of ACCEPTED) {
    if (accepted.paths.test(finding.relativePath)) return accepted.id
  }
  return 'blockers'
}

function main() {
  const argv = process.argv.slice(2)
  const root = argv.find(argument => !argument.startsWith('--'))
    ?? 'src/dsh-desktop-master/dsh-plugin-desktop-beta/dist/win-unpacked'
  const result = scanTree(root)
  const groups = new Map()
  const buckets = { blockers: [], foreign: [] }
  for (const finding of result.findings) {
    const bucket = classify(finding)
    const group = groups.get(bucket) ?? { id: bucket, hits: new Set(), since: finding.since, note: finding.note }
    group.hits.add(`${finding.relativePath}${finding.symbols.length > 0 ? ` :: ${finding.symbols.join(', ')}` : ` (${finding.dll})`}`)
    groups.set(bucket, group)
    if (bucket === 'blockers' || bucket === 'foreign') buckets[bucket].push(finding)
  }

  console.log(`root             : ${root}`)
  console.log(`files inspected  : ${result.census.inspected} (PE: ${result.census.pe}, non-PE: ${result.census.notPe})`)
  console.log(`architectures    : ${JSON.stringify(result.census.byMachine)}`)
  console.log('')

  const blockers = groups.get('blockers')
  if (blockers === undefined) {
    console.log('WIN7 GATE: PASS — no unreviewed Windows 8+ import in the x64 payload')
  } else {
    console.log(`WIN7 GATE: FAIL — ${blockers.hits.size} unreviewed finding(s)`)
    for (const hit of [...blockers.hits].sort()) console.log(`   - ${hit}`)
  }

  for (const accepted of ACCEPTED) {
    const group = groups.get(accepted.id)
    if (group === undefined) continue
    console.log(`\n[accepted] ${accepted.id} (${group.since}) ${group.hits.size} hit(s)`)
    console.log(`   imports   : ${group.note}`)
    for (const line of accepted.evidence) console.log(`   evidence  : ${line}`)
    console.log(`   outcome   : ${accepted.outcome}`)
    for (const hit of [...group.hits].sort().slice(0, 4)) console.log(`   - ${hit}`)
    if (group.hits.size > 4) console.log(`   ... ${group.hits.size - 4} more`)
  }

  const foreign = groups.get('foreign')
  if (foreign !== undefined) {
    console.log(`\n[foreign] arm64/darwin payload in an x64 install: ${foreign.hits.size} image(s)`)
    for (const hit of [...foreign.hits].sort().slice(0, 5)) console.log(`   - ${hit}`)
    if (foreign.hits.size > 5) console.log(`   ... ${foreign.hits.size - 5} more`)
  }

  for (const finding of result.findings.filter(entry => entry.kind === 'parse-error')) {
    console.log(`\n[parse-error] ${finding.relativePath ?? finding.path}: ${finding.detail}`)
  }

  const jsonIndex = argv.indexOf('--json')
  if (jsonIndex !== -1) {
    const output = argv[jsonIndex + 1]
    writeFileSync(output, `${JSON.stringify({
      root,
      census: result.census,
      blockers: buckets.blockers,
      accepted: Object.fromEntries(ACCEPTED
        .filter(accepted => groups.has(accepted.id))
        .map(accepted => [accepted.id, [...groups.get(accepted.id).hits].sort()])),
      foreign: buckets.foreign,
    }, null, 2)}\n`)
    console.log(`\njson: ${output}`)
  }
  process.exitCode = blockers === undefined ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
