// Patch the packaged app so it loads on Node 16.15/16.16 (Electron 20/21).
//
// Electron 22 embeds Node 16.17; the earlier releases the Windows 7 line may need embed 16.15 or
// 16.16, and each of those lacks named exports the packages import. A missing named export aborts
// ESM instantiation of the whole graph — a silent dead process — so each one has to be replaced with
// a local equivalent. This edits an assembled application in place so the change can be tested in
// seconds instead of a 15-minute packaging round; whatever survives gets folded into
// scripts/node16-shell-shims.ts as a build-time rewrite.
//
//   node work/patch-node-exports.mjs <app-root>

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const appRoot = process.argv[2]
if (appRoot === undefined) {
  console.error('usage: patch-node-exports.mjs <app-root>')
  process.exit(2)
}

// Local stand-ins, keyed by the export they replace. Each is written once per file that needs it.
const polyfills = {
  isBuiltin: `const isBuiltin = (name) => {
	try { return require('node:module').builtinModules.includes(String(name).replace(/^node:/u, '')); } catch { return false; }
};`,
  stripTypeScriptTypes: `const stripTypeScriptTypes = (code) => String(code);`,
  getRandomValues: `const getRandomValues = (array) => {
	const bytes = require('node:crypto').randomBytes(array.byteLength);
	new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes);
	return array;
};`,
  parseArgs: `const parseArgs = (config = {}) => {
	const args = Array.isArray(config.args) ? config.args : process.argv.slice(2);
	const options = config.options ?? {};
	const values = {}; const positionals = [];
	for (let index = 0; index < args.length; index += 1) {
		const token = String(args[index]);
		if (!token.startsWith('-')) { positionals.push(token); continue; }
		const [rawName, inlineValue] = token.replace(/^-+/u, '').split('=');
		const spec = options[rawName];
		if (spec === undefined) { if (config.strict === true) throw new Error('Unknown option ' + token); continue; }
		const takesValue = (spec.type ?? 'string') === 'string';
		const value = takesValue ? (inlineValue ?? String(args[++index])) : !token.includes('=');
		const key = spec.multiple === true ? (values[rawName] ??= []) : values;
		if (spec.multiple === true) values[rawName].push(value); else values[rawName] = value;
		void key;
	}
	return { values, positionals };
};`,
  styleText: `const styleText = (_format, text) => String(text);`,
  aborted: `const aborted = (signal) => new Promise((_resolve, reject) => {
	if (signal.aborted) { reject(signal.reason); return; }
	signal.addEventListener('abort', () => { reject(signal.reason); }, { once: true });
});`,
  getSystemErrorMessage: `const getSystemErrorMessage = (code) => {
	try { return require('node:util').getSystemErrorName(Number(code)); } catch { return String(code); }
};`,
  addAbortListener: `const addAbortListener = (signal, listener) => {
	if (signal.aborted) { listener(); return { [Symbol.dispose || Symbol.for('dispose')]() {} }; }
	signal.addEventListener('abort', listener, { once: true });
	return { [Symbol.dispose || Symbol.for('dispose')]() { signal.removeEventListener('abort', listener); } };
};`,
  tracingChannel: `const tracingChannel = (_name) => ({
	start() {}, end() {}, asyncStart() {}, asyncEnd() {}, error() {},
	subscribe() {}, unsubscribe() {}, hasSubscribers: false,
});`,
  globSync: `const globSync = () => [];`,
  availableParallelism: `const availableParallelism = () => {
	try { return require('node:os').cpus().length || 1; } catch { return 1; }
};`,
  getDefaultHighWaterMark: `const getDefaultHighWaterMark = () => 16384;`,
}

// The named exports Node 16.15/16.16 lacks, measured on the target runtime with
// work/check-node-exports.cjs. A runtime test here would use the host's Node (24) and find every name
// present, which is why the set is explicit.
const missing = new Set([
  'isBuiltin', 'stripTypeScriptTypes', 'getRandomValues', 'parseArgs', 'styleText', 'aborted',
  'getSystemErrorMessage', 'addAbortListener', 'tracingChannel', 'globSync',
  'availableParallelism', 'getDefaultHighWaterMark',
])

// Also matches `import Default, { ... } from "node:x"`, which several chunks use.
const importPattern = /import\s+([A-Za-z0-9_$*]+(?:\s*,\s*)?)?\{([^}]+)\}\s*from\s*["'](node:[^"']+)["'];?/gu
const changed = []

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry)
    if (statSync(full).isDirectory()) {
      // node_modules must be walked too: the main process loads packages such as
      // @deepseek-ai/dsh-app-boot, and those hit the same missing exports.
      if (entry === 'native-ui') continue
      walk(full)
      continue
    }
    if (!entry.endsWith('.js')) continue
    let text
    try { text = readFileSync(full, 'utf8') } catch { continue }
    if (!text.includes('from "node:') && !text.includes("from 'node:")) continue

    const needed = new Set()
    const rewritten = text.replace(importPattern, (whole, defaultPart, specifiers, specifier) => {
      const parts = specifiers.split(',').map(part => part.trim()).filter(Boolean)
      const kept = []
      let touched = false
      for (const part of parts) {
        const name = part.split(/\s+as\s+/u)[0].replace(/^type\s+/u, '').trim()
        if (!missing.has(name)) { kept.push(part); continue }
        needed.add(name)
        touched = true
      }
      if (!touched) return whole
      const prefix = defaultPart === undefined ? '' : defaultPart.trim()
      if (kept.length === 0) {
        return prefix === ''
          ? `// removed imports unavailable on Node 16.15/16.16 from ${specifier}`
          : `import ${prefix} from "${specifier}";`
      }
      const head = prefix === '' ? 'import ' : `import ${prefix} `
      return `${head}{ ${kept.join(', ')} } from "${specifier}";`
    })

    if (needed.size === 0) continue
    const header = [...needed].map(name => `// Node 16.15/16.16 compatibility: ${name}\n${polyfills[name]}`).join('\n')
    writeFileSync(full, `${header}\n${rewritten}`, 'utf8')
    changed.push(`${full.split(/[\\/]/u).slice(-1)[0]}  <- ${[...needed].join(', ')}`)
  }
}

walk(appRoot)
console.log(`patched ${changed.length} files`)
for (const item of changed) console.log(`  ${item}`)
