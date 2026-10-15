import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'
import { legacyColorMix, legacyColorMixPlugin } from './scripts/legacy-color-mix.ts'

const { name } = JSON.parse(readFileSync('package.json', 'utf8'))

/** At-rules whose bodies are not selector lists and must be copied verbatim. */
const UNPREFIXED_AT_RULES = /^@(?:keyframes|-webkit-keyframes|font-face|property|charset|import|namespace|page|counter-style|font-feature-values)\b/iu

/**
 * Materialise a scope as a selector prefix instead of `@scope`.
 *
 * `@scope` only shipped in Chromium 118, while the desktop shell may run on
 * older Chromium builds where the whole block would be dropped. Rewriting each
 * selector as a descendant of the scope host gives the same effect on any
 * Chromium that supports `:has()` (105+). At-rules keep their prelude and are
 * recursed into; descriptor at-rules are emitted untouched.
 */
function expandScope(css: string, scopeSelector: string): string {
  const prefix = (selectorList: string): string => selectorList
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => (part.startsWith(':scope') ? part.replace(/^:scope\b/u, scopeSelector) : `${scopeSelector} ${part}`))
    .join(',')

  let out = ''
  let cursor = 0
  while (cursor < css.length) {
    // Comments are not part of any prelude: emit them verbatim so a leading
    // banner (e.g. Tailwind's licence header) cannot swallow the next at-rule.
    if (css.startsWith('/*', cursor)) {
      const end = css.indexOf('*/', cursor + 2)
      const stop = end < 0 ? css.length : end + 2
      out += css.slice(cursor, stop)
      cursor = stop
      continue
    }
    const whitespace = /^\s+/u.exec(css.slice(cursor))
    if (whitespace) { out += whitespace[0]; cursor += whitespace[0].length; continue }

    const open = css.indexOf('{', cursor)
    if (open < 0) { out += css.slice(cursor); break }
    const prelude = css.slice(cursor, open).replace(/\/\*[\s\S]*?\*\//gu, ' ').trim()
    let depth = 1
    let scan = open + 1
    while (scan < css.length && depth > 0) {
      const ch = css[scan]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      scan++
    }
    const body = css.slice(open + 1, scan - 1)
    if (prelude.startsWith('@')) {
      out += UNPREFIXED_AT_RULES.test(prelude) ? `${prelude}{${body}}` : `${prelude}{${expandScope(body, scopeSelector)}}`
    } else {
      out += `${prefix(prelude)}{${body}}`
    }
    cursor = scan
  }
  return out
}

// The official Loader owns styles created inside a client factory. Keep the
// existing native components' CSS active only while their onboarding is shown.
function onboardingStyles(): Plugin {
  return {
    name: 'desktop-onboarding-styles',
    enforce: 'post',
    generateBundle: { order: 'post', handler(_options, bundle) {
      const client = bundle['client.js']
      if (client?.type !== 'chunk') throw new Error('Missing Desktop client entry')
      for (const [file, asset] of Object.entries(bundle)) {
        if (asset.type !== 'asset' || !file.endsWith('.css')) continue
        // This pass inlines the stylesheet, so it is the last place the emitted
        // CSS is still a string: render the Chromium 108 colour fallbacks here
        // as well, because the lib build has no HTML entry for the asset phase.
        const rendered = legacyColorMix(String(asset.source))
        // Inside the scope, Tailwind's root theme must target the scope host.
        const source = rendered.replace(/:root,\s*:host\s*\{/gu, ':scope {')
        const css = expandScope(source, ':root:has(.dshDesktopOnboardingContent)')
        const install = `const style = document.createElement('style'); style.textContent = ${JSON.stringify(css)}; document.head.appendChild(style);`
        const anchor = 'var exports = module.exports;'
        if (!client.code.includes(anchor)) throw new Error('Missing Desktop client factory')
        client.code = client.code.replace(anchor, () => anchor + install)
        delete bundle[file]
      }
    } },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), legacyColorMixPlugin(), onboardingStyles()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'lib', emptyOutDir: false, target: 'es2022', minify: false,
    lib: { entry: 'src/client/index.ts', formats: ['cjs'], fileName: () => 'client.js' },
    rollupOptions: {
      external: id => /^(react(?:-dom)?(?:\/|$)|@deepseek-ai\/)/u.test(id),
      output: {
        codeSplitting: false,
        banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {`,
        intro: 'var module = { exports: {} }; var exports = module.exports;',
        footer: 'return module.exports; } });',
      },
    },
  },
})
