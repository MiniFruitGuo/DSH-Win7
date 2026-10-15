import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Emit the CommonJS entry Electron loads as the main script.
 *
 * The application is ESM (`"type": "module"`), but Electron only accepts an ESM
 * main entry from v28 onward; Electron 22 — the last release supporting Windows
 * 7 SP1 — loads the main script through `require()`, which throws
 * `ERR_REQUIRE_ESM` for an `import`-based file.
 *
 * A generated `.cjs` shim keeps the ESM build intact and hands the real entry
 * over through a dynamic `import()`, which works from CommonJS without pulling
 * the ESM graph back through `require`.
 *
 * This file is written verbatim rather than transpiled: a bundler targeting CJS
 * is free to rewrite `import()` into `require()`, which is exactly the call that
 * cannot work here.
 *
 * The same shim installs the Node 16 compatibility gaps the main process
 * actually reaches. Electron 22 embeds Node 16 while the DSH packages are
 * written against Node 22, and a missing global surfaces as a dead window rather
 * than an error, so the gaps are filled before the ESM graph reaches the loader.
 * Only gaps with a faithful fallback are filled; a feature that cannot be
 * emulated stays absent so its caller fails loudly instead of quietly.
 */
const shim = `'use strict'

const installNode16Globals = () => {
  const define = (target, name, value) => {
    if (target[name] === undefined) {
      Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false })
    }
  }

  // Node 17+. The structured-clone algorithm and V8's serializer share the same
  // value model, so the round trip matches the native behaviour.
  define(globalThis, 'structuredClone', value => {
    const v8 = require('node:v8')
    return v8.deserialize(v8.serialize(value))
  })

  // Node 22+.
  define(Promise, 'withResolvers', () => {
    let resolve
    let reject
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  })

  // Node 22+. Non-throwing parse: returns null instead of raising.
  define(URL, 'parse', (input, base) => {
    try {
      return new URL(input, base)
    } catch {
      return null
    }
  })
  // Node 18.17+.
  define(URL, 'canParse', (input, base) => {
    try {
      new URL(input, base)
      return true
    } catch {
      return false
    }
  })

  // Node 17.3+/20.3+.
  define(AbortSignal, 'timeout', milliseconds => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    }, milliseconds)
    if (typeof timer.unref === 'function') timer.unref()
    return controller.signal
  })
  define(AbortSignal, 'any', signals => {
    const controller = new AbortController()
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason)
        break
      }
      signal.addEventListener('abort', () => { controller.abort(signal.reason) }, { once: true })
    }
    return controller.signal
  })

  // Node 22.3+.
  define(process, 'getBuiltinModule', name => require(name.startsWith('node:') ? name : \`node:\${name}\`))

  // Node 20.12+: read a .env file into process.env, matching the Node contract.
  const parseEnvFile = content => {
    const result = {}
    for (const rawLine of String(content).split(/\\r?\\n/u)) {
      const line = rawLine.trim()
      if (line === '' || line.startsWith('#')) continue
      const match = /^(?:export\\s+)?([A-Za-z_][A-Za-z0-9_.]*)\\s*=\\s*(.*)$/u.exec(line)
      if (match === null) continue
      let value = (match[2] ?? '').trim()
      const quote = value[0]
      if (quote === '"' || quote === "'") {
        const closing = value.indexOf(quote, 1)
        value = closing === -1 ? value.slice(1) : value.slice(1, closing)
        if (quote === '"') {
          value = value.replace(/\\\\n/gu, '\\n').replace(/\\\\r/gu, '\\r').replace(/\\\\t/gu, '\\t')
            .replace(/\\\\"/gu, '"').replace(/\\\\\\\\/gu, '\\\\')
        }
      } else {
        const comment = value.search(/\\s#/u)
        if (comment !== -1) value = value.slice(0, comment).trim()
      }
      result[match[1] ?? ''] = value
    }
    return result
  }
  define(process, 'loadEnvFile', filename => {
    const target = filename ?? '.env'
    const parsed = parseEnvFile(require('node:fs').readFileSync(target, 'utf8'))
    for (const [key, value] of Object.entries(parsed)) process.env[key] = value
  })

  // Node 20+ non-mutating array copies.
  define(Array.prototype, 'toSorted', function (compare) { return [...this].sort(compare) })
  define(Array.prototype, 'toReversed', function () { return [...this].reverse() })
  define(Array.prototype, 'toSpliced', function (...args) {
    const copy = [...this]
    copy.splice(...args)
    return copy
  })
  define(Array.prototype, 'with', function (index, value) {
    const copy = [...this]
    const at = index < 0 ? copy.length + index : index
    if (at < 0 || at >= copy.length) throw new RangeError('Invalid index')
    copy[at] = value
    return copy
  })

  // Node 21+ grouping.
  define(Object, 'groupBy', (items, key) => {
    const result = Object.create(null)
    for (const item of items) {
      const group = String(key(item))
      if (result[group] === undefined) result[group] = []
      result[group].push(item)
    }
    return result
  })
  define(Map, 'groupBy', (items, key) => {
    const result = new Map()
    for (const item of items) {
      const group = key(item)
      const bucket = result.get(group)
      if (bucket === undefined) result.set(group, [item])
      else bucket.push(item)
    }
    return result
  })

  // Node 22+ async iteration helper.
  define(Array, 'fromAsync', async (iterable, map) => {
    const result = []
    let index = 0
    for await (const item of iterable) result.push(map === undefined ? item : await map(item, index++))
    return result
  })

  // Node 22+ set algebra.
  const setMethod = (name, implementation) => {
    define(Set.prototype, name, function (other) { return implementation.call(this, other) })
  }
  setMethod('union', function (other) { return new Set([...this, ...other]) })
  setMethod('intersection', function (other) {
    const right = new Set(other)
    return new Set([...this].filter(value => right.has(value)))
  })
  setMethod('difference', function (other) {
    const right = new Set(other)
    return new Set([...this].filter(value => !right.has(value)))
  })
  setMethod('symmetricDifference', function (other) {
    const right = new Set(other)
    return new Set([
      ...[...this].filter(value => !right.has(value)),
      ...[...right].filter(value => !this.has(value)),
    ])
  })
  setMethod('isSubsetOf', function (other) {
    const right = new Set(other)
    return [...this].every(value => right.has(value))
  })
  setMethod('isSupersetOf', function (other) { return [...other].every(value => this.has(value)) })
  setMethod('isDisjointFrom', function (other) {
    const right = new Set(other)
    return [...this].every(value => !right.has(value))
  })

  // Node 24 escapes a literal string for use inside a RegExp source.
  define(RegExp, 'escape', value => String(value).replace(/[\\\\^$.*+?()[\\]{}|/]/gu, '\\\\$&'))
  // Node 24 error detection that survives cross-realm values.
  define(Error, 'isError', value => value instanceof Error)

  // Node 20+ well-formedness helpers for UTF-16 strings.
  const toWellFormed = function () {
    let result = ''
    for (let index = 0; index < this.length; index += 1) {
      const code = this.charCodeAt(index)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = this.charCodeAt(index + 1)
        if (next >= 0xdc00 && next <= 0xdfff) { result += this[index] + this[index + 1]; index += 1 }
        else result += '\\ufffd'
      } else if (code >= 0xdc00 && code <= 0xdfff) result += '\\ufffd'
      else result += this[index]
    }
    return result
  }
  define(String.prototype, 'toWellFormed', toWellFormed)
  define(String.prototype, 'isWellFormed', function () { return toWellFormed.call(this) === String(this) })

  // Node 16 keeps the Web platform pieces in builtins instead of on the global
  // object. Packages written for Node 20+ read them as globals at module scope,
  // so re-publish what the runtime already provides.
  try {
    const streamWeb = require('node:stream/web')
    for (const [name, value] of Object.entries(streamWeb)) define(globalThis, name, value)
  } catch { /* the builtin is unavailable; leave the globals absent */ }
  try {
    const { MessageChannel, MessagePort } = require('node:worker_threads')
    define(globalThis, 'MessageChannel', MessageChannel)
    define(globalThis, 'MessagePort', MessagePort)
  } catch { /* nothing to publish */ }
  try {
    const { Blob, File } = require('node:buffer')
    define(globalThis, 'Blob', Blob)
    if (File !== undefined) define(globalThis, 'File', File)
  } catch { /* nothing to publish */ }
  // Node 18.13+ only; derive it from the Blob that every supported runtime has.
  if (globalThis.File === undefined && globalThis.Blob !== undefined) {
    const BlobClass = globalThis.Blob
    define(globalThis, 'File', class File extends BlobClass {
      constructor(parts = [], name = '', options = {}) {
        super(parts, options)
        this.name = String(name)
        this.lastModified = options.lastModified ?? Date.now()
      }
    })
  }
  // Node 19+ exposes webcrypto as \`crypto\`; Node 16 keeps it on the module.
  if (globalThis.crypto === undefined) {
    try {
      define(globalThis, 'crypto', require('node:crypto').webcrypto)
    } catch { /* leave it absent */ }
  }
  define(globalThis, 'DOMException', class DOMException extends Error {
    constructor(message = '', name = 'Error') {
      super(message)
      this.name = name
    }
  })
  define(globalThis, 'navigator', {
    userAgent: \`Node.js/\${process.version}\`,
    platform: process.platform,
    hardwareConcurrency: require('node:os').cpus().length,
    language: 'en',
  })
}

installNode16Globals()

// Chromium's shader disk cache cannot be upgraded in place on this runtime: it reports
// "Disk cache backend for take index file has wrong size" (simple_version_upgrade.cc) and the
// process then aborts. The shell renders in software, so that cache has nothing worth keeping —
// and a directory left half-written by an earlier aborted run would otherwise fail on every start.
if (process.env.DSH_DESKTOP_ENABLE_GPU !== '1') {
  try {
    const electron = require('electron')
    electron.app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
    // V8 hands pages back through EmulatedVirtualAddressSubspace on this runtime — the Windows
    // fallback it uses when the address-space reservation it wanted is unavailable — and that path's
    // page accounting aborts the process (0x80000003, no message, no window). Everything here lowers
    // the address space V8 asks for or the number of threads that can release it:
    //   --no-wasm-trap-handler   WebAssembly reserves a large guard region per instance for its
    //                            trap handler; this is the biggest single reservation to remove
    //   --no-concurrent-sweeping Releasing pages from background GC threads is the cheapest trigger
    //   --no-concurrent-marking  to remove; with these two the shell survives about two runs in three
    //   --max-old-space-size     Keeps the cage from having to grow while the window comes up
    // Anything already in the environment wins, and probe-v8-flags.ps1 in the delivery folder tests
    // combinations on a machine that reproduces the abort.
    const v8Flags = process.env.DSH_DESKTOP_V8_FLAGS
      ?? '--no-wasm-trap-handler --no-concurrent-sweeping --no-concurrent-marking --max-old-space-size=2048'
    electron.app.commandLine.appendSwitch('js-flags', v8Flags)
    const { rmSync } = require('node:fs')
    const { join } = require('node:path')
    // Only caches: no settings, sessions or profiles live here.
    for (const name of ['GPUCache', 'ShaderCache', 'GrShaderCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache']) {
      try { rmSync(join(electron.app.getPath('userData'), name), { recursive: true, force: true }) } catch {}
    }
    electron.app.disableHardwareAcceleration()
  } catch { /* not running under Electron: CLI runs and tests keep the default */ }
}

// Electron 22 loads the main entry with require(), and require() cannot load an
// ES module. Hand the real entry to the ESM loader instead and surface any
// startup failure as a non-zero exit rather than a silent dead window.
import('./main.js').catch((error) => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error)
  process.stderr.write(\`dsh-plugin-desktop: main process failed to start\\n\${detail}\\n\`)
  process.exit(1)
})
`

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const target = join(packageRoot, 'lib', 'main-entry.cjs')

mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, shim)
process.stdout.write(`main entry shim written: ${target}\n`)
