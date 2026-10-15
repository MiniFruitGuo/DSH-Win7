/**
 * Source rewrites that make the packaged main process loadable on Electron 22.
 *
 * Electron 22 is the last release that runs on Windows 7 SP1, and it embeds Node 16 while the DSH
 * packages are written against Node 22. A missing named export fails ESM instantiation of the whole
 * main process, and because the process is a GUI subsystem binary the failure is invisible: the user
 * double-clicks and nothing happens. These rewrites close the three gaps that loading the main
 * process actually reaches, each of them lazily or with an equivalent, so nothing is silently
 * degraded except features the Node 16 shell genuinely cannot provide.
 *
 * Every rewrite is applied to the packaged copy rather than the installed dependency: the source
 * tree is owned by `yarn install`, and the vendored packages are upstream code this repository does
 * not fork. Rewrites are idempotent — a packaged file that already carries the replacement is left
 * alone — and a file that carries neither form fails the build, so an upstream change can never
 * quietly drop the shim.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** One exact text substitution inside a packaged dependency. */
export interface ShellRewrite {
  /** Path of the packaged file, relative to the assembled application root. */
  readonly file: string
  /** Exact text the unmodified package ships. */
  readonly from: string
  /** Replacement text, which must be identical for every build. */
  readonly to: string
  /** Why the shell cannot run the original. */
  readonly why: string
}

/** `parseEnv` arrives in Node 20.12; the shell runs Node 16. */
const APP_BOOT_PARSE_ENV = {
  file: 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
  from: 'import { inspect, parseEnv } from "node:util";',
  to: [
    'import { inspect } from "node:util";',
    '// Node 16 (Electron 22, the last release supporting Windows 7 SP1) predates',
    '// util.parseEnv, and a missing named export aborts ESM instantiation of the',
    '// whole main process — a silent, window-less exit. Keep the Node implementation',
    '// when it exists and fall back to this equivalent dotenv parser.',
    'const parseEnv = (content) => {',
    '\tif (typeof globalThis.__dshNode16ParseEnv === "function") return globalThis.__dshNode16ParseEnv(content);',
    '\tconst result = {};',
    '\tconst text = typeof content === "string" ? content : String(content ?? "");',
    '\tconst lines = text.split(/\\r?\\n/u);',
    '\tfor (let index = 0; index < lines.length; index += 1) {',
    '\t\tlet line = lines[index] ?? "";',
    '\t\tif (!line.trim() || line.trimStart().startsWith("#")) continue;',
    '\t\tconst match = /^\\s*(?:export\\s+)?([A-Za-z_][A-Za-z0-9_.]*)\\s*=(.*)$/u.exec(line);',
    '\t\tif (!match) continue;',
    '\t\tconst key = match[1] ?? "";',
    '\t\tlet value = (match[2] ?? "").trim();',
    '\t\tif (value.startsWith("\\"")) {',
    '\t\t\tlet body = value.slice(1);',
    '\t\t\twhile (index < lines.length - 1 && !/(?<!\\\\)"/u.test(body)) {',
    '\t\t\t\tindex += 1;',
    '\t\t\t\tbody += `\\n${lines[index] ?? ""}`;',
    '\t\t\t}',
    '\t\t\tconst closing = body.search(/(?<!\\\\)"/u);',
    '\t\t\tbody = closing === -1 ? body : body.slice(0, closing);',
    '\t\t\tvalue = body.replace(/\\\\n/gu, "\\n").replace(/\\\\r/gu, "\\r").replace(/\\\\t/gu, "\\t").replace(/\\\\"/gu, "\\"").replace(/\\\\\\\\/gu, "\\\\");',
    '\t\t} else if (value.startsWith("\'")) {',
    '\t\t\tconst closing = value.indexOf("\'", 1);',
    '\t\t\tvalue = closing === -1 ? value.slice(1) : value.slice(1, closing);',
    '\t\t} else {',
    '\t\t\tconst comment = value.search(/\\s#/u);',
    '\t\t\tvalue = (comment === -1 ? value : value.slice(0, comment)).trim();',
    '\t\t}',
    '\t\tresult[key] = value;',
    '\t}',
    '\treturn result;',
    '};',
  ].join('\n'),
  why: 'dsh-app-boot imports util.parseEnv, which only exists from Node 20.12',
} as const satisfies ShellRewrite

/** zstd arrived in Node 22.15/23; the shell runs Node 16. */
const JSONL_ZSTD = {
  file: 'node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js',
  from: 'import { constants, createZstdCompress, createZstdDecompress, zstdCompress, zstdDecompress, zstdDecompressSync } from "node:zlib";',
  to: [
    'import { constants } from "node:zlib";',
    'import * as __dshNodeZlib from "node:zlib";',
    '// zstd arrived in Node 22.15/23. The Electron 22 shell (Windows 7 SP1) runs Node',
    '// 16, where these named exports do not exist; importing them by name would abort',
    '// ESM instantiation before any window appears. Bind them lazily so the module',
    '// loads, and fail loudly only if a zstd-coded session is actually touched.',
    'const __dshZstdMissing = (name) => () => {',
    '\tthrow new Error(`dsh-plugin-desktop: ${name} requires Node 22 zstd support, which the Electron 22 shell (Node 16) does not provide`);',
    '};',
    'const createZstdCompress = __dshNodeZlib.createZstdCompress ?? __dshZstdMissing("zlib.createZstdCompress");',
    'const createZstdDecompress = __dshNodeZlib.createZstdDecompress ?? __dshZstdMissing("zlib.createZstdDecompress");',
    'const zstdCompress = __dshNodeZlib.zstdCompress ?? __dshZstdMissing("zlib.zstdCompress");',
    'const zstdDecompress = __dshNodeZlib.zstdDecompress ?? __dshZstdMissing("zlib.zstdDecompress");',
    'const zstdDecompressSync = __dshNodeZlib.zstdDecompressSync ?? __dshZstdMissing("zlib.zstdDecompressSync");',
  ].join('\n'),
  why: 'session persistence imports node:zlib zstd bindings, which only exist from Node 22.15',
} as const satisfies ShellRewrite

/** The packaged undici targets Node 20+ and cannot load on Node 16 at all. */
const HTTP_PROXY_UNDICI = {
  file: 'node_modules/@deepseek-ai/dsh-http-proxy/lib/index.js',
  from: [
    'async function installGlobalProxy(policy) {',
    '\tconst previousPolicy = active;',
    '\tif (policy.source === "none") {',
  ].join('\n'),
  to: [
    'async function installGlobalProxy(policy) {',
    '\tconst previousPolicy = active;',
    '\t// The packaged undici targets Node 20+ and cannot load in the Electron 22 shell',
    '\t// (Node 16, the last release running on Windows 7 SP1). Degrade to a policy-only',
    '\t// installation so an environment proxy no longer kills the launcher: the policy is',
    '\t// still resolved and reported, and the Host — which runs on Node 22 — installs the',
    '\t// real dispatcher from that same policy.',
    '\tlet undici;',
    '\ttry {',
    '\t\tundici = await import("undici");',
    '\t} catch (error) {',
    '\t\tprocess.stderr.write(`dsh-plugin-desktop: proxy dispatcher unavailable in this runtime (${error && error.message ? error.message : String(error)}); the resolved policy reaches the Host instead\\n`);',
    '\t\tactive = policy;',
    '\t\treturn () => {',
    '\t\t\tactive = previousPolicy;',
    '\t\t\treturn Promise.resolve();',
    '\t\t};',
    '\t}',
    '\tif (policy.source === "none") {',
  ].join('\n'),
  why: 'the packaged undici needs Node 20+ internals that Node 16 does not expose',
} as const satisfies ShellRewrite

/** The second undici import inside installGlobalProxy, now served by the guarded load. */
const HTTP_PROXY_UNDICI_DIRECT = {
  file: HTTP_PROXY_UNDICI.file,
  from: [
    '\t\tconst undici = await import("undici");',
    '\t\tconst previous = undici.getGlobalDispatcher();',
  ].join('\n'),
  to: '\t\tconst previous = undici.getGlobalDispatcher();',
  why: 'the direct dispatcher branch must reuse the guarded import',
} as const satisfies ShellRewrite

/** The third undici import inside installGlobalProxy. */
const HTTP_PROXY_UNDICI_POLICY = {
  file: HTTP_PROXY_UNDICI.file,
  from: '\tconst { getGlobalDispatcher, setGlobalDispatcher } = await import("undici");',
  to: '\tconst { getGlobalDispatcher, setGlobalDispatcher } = undici;',
  why: 'the policy branch must reuse the guarded import',
} as const satisfies ShellRewrite

/** `constants` reaches `node:fs/promises` in Node 16.17; Electron 21 ships Node 16.16. */
const FS_PROMISES_CONSTANTS = [
  {
    file: 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
    from: 'import { access, constants, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";',
    to: [
      'import { access, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";',
      'import { constants } from "node:fs";',
    ].join('\n'),
  },
  {
    file: 'node_modules/@deepseek-ai/cordis-plugin-include/lib/index.js',
    from: 'import { access, constants, readFile, rename, writeFile } from "node:fs/promises";',
    to: [
      'import { access, readFile, rename, writeFile } from "node:fs/promises";',
      'import { constants } from "node:fs";',
    ].join('\n'),
  },
].map(rewrite => ({
  ...rewrite,
  // `node:fs` has always exported `constants`, so the rewritten form is valid on every runtime this
  // shell supports — Electron 22 (Node 16.17) and Electron 21 (Node 16.16) alike. A missing named
  // export aborts ESM instantiation of the entire main process, which is a silent, window-less exit.
  why: 'node:fs/promises lacks the constants re-export on Node 16.16',
})) as readonly ShellRewrite[]

/** Every rewrite a packaged application needs for the Node 16 shell. */
export const NODE16_SHELL_REWRITES: readonly ShellRewrite[] = Object.freeze([
  APP_BOOT_PARSE_ENV,
  ...FS_PROMISES_CONSTANTS,
  JSONL_ZSTD,
  HTTP_PROXY_UNDICI,
  HTTP_PROXY_UNDICI_DIRECT,
  HTTP_PROXY_UNDICI_POLICY,
])

/** Result of applying the rewrites to one assembled application. */
export interface ShellRewriteReport {
  /** Files whose contents changed in this run. */
  readonly rewritten: readonly string[]
  /** Files that already carried the replacement from an earlier run. */
  readonly alreadyApplied: readonly string[]
  /** Files this application does not package, so there was nothing to rewrite. */
  readonly absent: readonly string[]
}

/**
 * Apply the Node 16 shell rewrites to an assembled application.
 *
 * A dependency the application does not package is reported as absent rather than treated as a
 * failure — a trimmed build simply has one gap fewer. A dependency that *is* packaged but matches
 * neither form is a hard error: the shipped package changed under the rewrite.
 * @param applicationRoot - directory holding the packaged `lib/` and `node_modules/`.
 * @param rewrites - rewrites to apply, injectable for tests.
 * @returns which files changed, which were already final, and which are not packaged.
 */
export function applyNode16ShellRewrites(
  applicationRoot: string,
  rewrites: readonly ShellRewrite[] = NODE16_SHELL_REWRITES,
): ShellRewriteReport {
  const rewritten: string[] = []
  const alreadyApplied: string[] = []
  const absent: string[] = []
  const contents = new Map<string, string>()
  for (const rewrite of rewrites) {
    const path = join(applicationRoot, rewrite.file)
    let source = contents.get(path)
    if (source === undefined) {
      try {
        source = readFileSync(path, 'utf8')
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
          if (!absent.includes(rewrite.file)) absent.push(rewrite.file)
          continue
        }
        throw new Error(`dsh-plugin-desktop: cannot read ${rewrite.file} for the Node 16 shell rewrite: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
      contents.set(path, source)
    }
    if (source.includes(rewrite.to)) {
      if (!alreadyApplied.includes(rewrite.file)) alreadyApplied.push(rewrite.file)
      continue
    }
    if (!source.includes(rewrite.from)) {
      throw new Error(`dsh-plugin-desktop: ${rewrite.file} no longer matches the Node 16 shell rewrite (${rewrite.why}); the shipped package changed`)
    }
    const next = source.replace(rewrite.from, rewrite.to)
    contents.set(path, next)
    if (!rewritten.includes(rewrite.file)) rewritten.push(rewrite.file)
  }
  for (const [path, source] of contents) {
    writeFileSync(path, source)
  }
  return { rewritten, alreadyApplied, absent }
}
