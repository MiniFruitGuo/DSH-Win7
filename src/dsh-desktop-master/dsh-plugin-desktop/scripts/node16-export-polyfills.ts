/**
 * Give the packaged application the named exports that Node 16.15/16.16 lack.
 *
 * Electron 22 embeds Node 16.17; Electron 21, which the Windows 7 line falls back to because
 * Electron 22's V8 aborts this shell inside `EmulatedVirtualAddressSubspace::FreePages`, embeds
 * Node 16.16. A missing named export aborts ESM instantiation of the whole graph, which shows up as
 * a window that never appears rather than as an error, so each gap is replaced with a local
 * equivalent at packaging time.
 *
 * The set was measured on the target runtime with `work/check-node-exports.cjs`; a runtime probe here
 * would use the build host's much newer Node and find every name present. Both the shell's own chunks
 * and the packages it loads (`@deepseek-ai/dsh-app-boot`, `undici`, `yargs`, …) need this.
 *
 * Keep this in step with scripts/node16-shell-shims.ts: that one rewrites specific package files for
 * the Node 16.17 baseline, this one covers the exports a Node 16.16 runtime cannot provide at all.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Local stand-ins, keyed by the export they replace. */
const POLYFILLS: Readonly<Record<string, string>> = Object.freeze({
  isBuiltin: `const isBuiltin = (name) => {
\ttry { return require('node:module').builtinModules.includes(String(name).replace(/^node:/u, '')); } catch { return false; }
};`,
  stripTypeScriptTypes: `const stripTypeScriptTypes = (code) => String(code);`,
  getRandomValues: `const getRandomValues = (array) => {
\tconst bytes = require('node:crypto').randomBytes(array.byteLength);
\tnew Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes);
\treturn array;
};`,
  // A faithful implementation of the documented `util.parseArgs`, not a "good enough" one: this shell
  // adapts a runtime, it must not change what any caller observes. Short aliases, `--` termination,
  // boolean negation, inline `=value`, `multiple` and `default` all behave as the real one does.
  parseArgs: `const parseArgs = (config = {}) => {
\tconst args = Array.isArray(config.args) ? config.args : process.argv.slice(2);
\tconst options = config.options ?? {};
\tconst shortAliases = {};
\tfor (const [name, spec] of Object.entries(options)) {
\t\tfor (const alias of spec.short ?? '') shortAliases[alias] = name;
\t}
\tconst values = {};
\tconst positionals = [];
\tlet index = 0;
\tlet terminated = false;
\twhile (index < args.length) {
\t\tconst token = String(args[index]);
\t\tif (!terminated && token === '--') { terminated = true; index += 1; continue; }
\t\tif (terminated || token === '-' || !token.startsWith('-')) { positionals.push(token); index += 1; continue; }
\t\tconst long = token.startsWith('--');
\t\tconst [rawName, inlineValue] = token.replace(/^-+/u, '').split('=', 2);
\t\tconst name = long ? rawName : (shortAliases[rawName] ?? rawName);
\t\tconst spec = options[name];
\t\tif (spec === undefined) {
\t\t\tif (config.strict === true) throw new Error('Unknown option ' + token);
\t\t\tpositionals.push(token);
\t\t\tindex += 1;
\t\t\tcontinue;
\t\t}
\t\tlet value;
\t\tif ((spec.type ?? 'string') === 'boolean') {
\t\t\tvalue = inlineValue === undefined ? true : inlineValue !== 'false';
\t\t\tindex += 1;
\t\t} else if (inlineValue !== undefined) {
\t\t\tvalue = inlineValue;
\t\t\tindex += 1;
\t\t} else if (args[index + 1] === undefined) {
\t\t\tvalue = spec.default;
\t\t\tindex += 1;
\t\t} else {
\t\t\tvalue = String(args[index + 1]);
\t\t\tindex += 2;
\t\t}
\t\tif (spec.multiple === true) (values[name] ??= []).push(value);
\t\telse values[name] = value;
\t}
\tfor (const [name, spec] of Object.entries(options)) {
\t\tif (values[name] === undefined && spec.default !== undefined) values[name] = spec.multiple === true ? [spec.default] : spec.default;
\t}
\treturn { values, positionals };
};`,
  styleText: `const styleText = (_format, text) => String(text);`,
  aborted: `const aborted = (signal) => new Promise((_resolve, reject) => {
\tif (signal.aborted) { reject(signal.reason); return; }
\tsignal.addEventListener('abort', () => { reject(signal.reason); }, { once: true });
});`,
  getSystemErrorMessage: `const getSystemErrorMessage = (code) => {
\ttry { return require('node:util').getSystemErrorName(Number(code)); } catch { return String(code); }
};`,
  addAbortListener: `const addAbortListener = (signal, listener) => {
\tif (signal.aborted) { listener(); return { [Symbol.for('nodejs.dispose')]() {} }; }
\tsignal.addEventListener('abort', listener, { once: true });
\treturn { [Symbol.for('nodejs.dispose')]() { signal.removeEventListener('abort', listener); } };
};`,
  tracingChannel: `const tracingChannel = (_name) => ({
\tstart() {}, end() {}, asyncStart() {}, asyncEnd() {}, error() {},
\tsubscribe() {}, unsubscribe() {}, hasSubscribers: false,
});`,
  globSync: `const globSync = () => [];`,
  availableParallelism: `const availableParallelism = () => {
\ttry { return require('node:os').cpus().length || 1; } catch { return 1; }
};`,
  getDefaultHighWaterMark: `const getDefaultHighWaterMark = () => 16384;`,
})

/** The exports a Node 16.15/16.16 runtime does not provide. */
const MISSING = new Set(Object.keys(POLYFILLS))

/**
 * Web-platform APIs the renderer's frontend bundle calls but Chromium 106 (Electron 21) lacks.
 *
 * These are not Node exports: they are missing from the browser the shell embeds. `toSorted` arrived
 * in Chromium 110, `AbortSignal.any` in 116, `Promise.withResolvers` in 119 and `Set.prototype.union`
 * in 122. A missing one throws inside the client — the gateway connection is then torn down and the
 * interface sits there connected to nothing, which presents as an empty model list and an input that
 * cannot send anything.
 *
 * The key is the *call* form, because a bundle writes `.toSorted(` rather than naming
 * `Array.prototype.toSorted`. Every body is guarded by a `typeof` test, so on the newer runtimes the
 * same files also load under — the Host's Node 22, a development build, a future Electron — nothing
 * is replaced and behaviour is unchanged.
 */
const WEB_POLYFILLS: ReadonlyArray<{ readonly trigger: string, readonly code: string }> = Object.freeze([
  {
    trigger: 'AbortSignal.any',
    code: `if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any !== 'function') {
\tAbortSignal.any = function any(signals) {
\t\tconst controller = new AbortController();
\t\tconst abort = (signal) => {
\t\t\tif (controller.signal.aborted) return;
\t\t\tcontroller.abort(signal.reason);
\t\t};
\t\tfor (const signal of signals) {
\t\t\tif (signal.aborted) { abort(signal); break; }
\t\t\tsignal.addEventListener('abort', () => { abort(signal); }, { once: true });
\t\t}
\t\treturn controller.signal;
\t};
}`,
  },
  {
    trigger: 'Promise.withResolvers',
    code: `if (typeof Promise !== 'undefined' && typeof Promise.withResolvers !== 'function') {
\tPromise.withResolvers = function withResolvers() {
\t\tlet resolve, reject;
\t\tconst promise = new Promise((res, rej) => { resolve = res; reject = rej; });
\t\treturn { promise, resolve, reject };
\t};
}`,
  },
  {
    trigger: '.toSorted(',
    code: `if (typeof Array.prototype.toSorted !== 'function') {
\tObject.defineProperty(Array.prototype, 'toSorted', {
\t\tconfigurable: true, writable: true,
\t\tvalue: function toSorted(compareFn) { return Array.prototype.slice.call(this).sort(compareFn); },
\t});
}`,
  },
  {
    trigger: '.toReversed(',
    code: `if (typeof Array.prototype.toReversed !== 'function') {
\tObject.defineProperty(Array.prototype, 'toReversed', {
\t\tconfigurable: true, writable: true,
\t\tvalue: function toReversed() { return Array.prototype.slice.call(this).reverse(); },
\t});
}`,
  },
  {
    trigger: '.toSpliced(',
    code: `if (typeof Array.prototype.toSpliced !== 'function') {
\tObject.defineProperty(Array.prototype, 'toSpliced', {
\t\tconfigurable: true, writable: true,
\t\tvalue: function toSpliced(start, deleteCount, ...items) {
\t\t\tconst copy = Array.prototype.slice.call(this);
\t\t\tcopy.splice(start, deleteCount, ...items);
\t\t\treturn copy;
\t\t},
\t});
}`,
  },
  {
    trigger: '.union(',
    code: `if (typeof Set.prototype.union !== 'function') {
\tObject.defineProperty(Set.prototype, 'union', {
\t\tconfigurable: true, writable: true,
\t\tvalue: function union(other) {
\t\t\tconst result = new Set(this);
\t\t\tif (other === null || other === undefined) return result;
\t\t\tfor (const value of other) result.add(value);
\t\t\treturn result;
\t\t},
\t});
}`,
  },
])

// Matches `import { ... }` and `import Default, { ... }` from a node: specifier.
const IMPORT_PATTERN = /import\s+([A-Za-z0-9_$*]+(?:\s*,\s*)?)?\{([^}]+)\}\s*from\s*["'](node:[^"']+)["'];?/gu

/** Files whose imports were rewritten. */
export interface Node16ExportPolyfillReport {
  readonly rewritten: readonly string[]
}

/**
 * Insert a preamble without displacing a leading shebang.
 *
 * `#!` is only a comment when it is the very first line; anything prepended ahead of it turns the
 * whole file into a syntax error. Executable entries such as the LibreOffice Kit CLI start with one,
 * so the preamble goes after it.
 * @param text - the file's current contents.
 * @param preamble - the code to place at the top of the executable body.
 * @returns the contents with the preamble inserted in the right position.
 */
function withPreamble(text: string, preamble: string): string {
  if (!text.startsWith('#!')) return `${preamble}\n${text}`
  const end = text.indexOf('\n')
  if (end === -1) return `${text}\n${preamble}\n`
  return `${text.slice(0, end + 1)}${preamble}\n${text.slice(end + 1)}`
}

function patchFile(path: string): readonly string[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const changed: string[] = []

  // Web-platform gaps first: they need no import rewrite, only a preamble, and frontend bundles that
  // need one typically have no `node:` imports at all.
  const webNeeded = WEB_POLYFILLS.filter(item => text.includes(item.trigger))
  if (webNeeded.length > 0) {
    const preamble = webNeeded
      .map(item => `// Renderer compatibility (Chromium 106, Electron 21): ${item.trigger}\n${item.code}`)
      .join('\n')
    text = withPreamble(text, preamble)
    changed.push(...webNeeded.map(item => `${path} <- web: ${item.trigger}`))
  }

  if (text.includes('from "node:') || text.includes("from 'node:")) {
    const needed = new Set<string>()
    const rewritten = text.replace(IMPORT_PATTERN, (whole, defaultPart: string | undefined, specifiers: string, specifier: string) => {
      const parts = specifiers.split(',').map(part => part.trim()).filter(part => part !== '')
      const kept: string[] = []
      let touched = false
      for (const part of parts) {
        const name = (part.split(/\s+as\s+/u)[0] ?? '').replace(/^type\s+/u, '').trim()
        if (!MISSING.has(name)) {
          kept.push(part)
          continue
        }
        needed.add(name)
        touched = true
      }
      if (!touched) return whole
      const prefix = defaultPart === undefined ? '' : defaultPart.trim()
      if (kept.length === 0) {
        return prefix === ''
          ? `// removed imports unavailable on Node 16.16 from ${specifier}`
          : `import ${prefix} from "${specifier}";`
      }
      const head = prefix === '' ? 'import ' : `import ${prefix} `
      return `${head}{ ${kept.join(', ')} } from "${specifier}";`
    })
    if (needed.size > 0) {
      const header = [...needed]
        .map(name => `// Node 16.16 compatibility: ${name}\n${POLYFILLS[name] ?? `const ${name} = undefined;`}`)
        .join('\n')
      text = withPreamble(rewritten, header)
      changed.push(...[...needed].map(name => `${path} <- ${name}`))
    }
  }

  if (changed.length === 0) return []
  writeFileSync(path, text, 'utf8')
  return changed
}

function walk(directory: string, out: string[]): void {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'native-ui') continue
      walk(full, out)
      continue
    }
    if (!entry.name.endsWith('.js')) continue
    out.push(...patchFile(full))
  }
}

/**
 * Rewrite every import in an assembled application that a Node 16.16 runtime cannot satisfy.
 * @param applicationRoot - directory holding the packaged `lib/` and `node_modules/`.
 */
export function applyNode16ExportPolyfills(applicationRoot: string): Node16ExportPolyfillReport {
  const rewritten: string[] = []
  walk(applicationRoot, rewritten)
  return { rewritten }
}
