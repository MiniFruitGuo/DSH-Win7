import type { Plugin } from 'vite'

/**
 * Render Tailwind v4 opacity modifiers on Chromium 108.
 *
 * Tailwind v4 implements every `/NN` opacity modifier with `color-mix()`, which
 * needs Chromium 111, and wraps the rule in
 * `@supports (color:color-mix(in lab, red, red))`. Chromium 108 evaluates that
 * guard as false and drops the whole block, so the surface silently loses its
 * tint instead of degrading. Electron 22 — the last release that runs on
 * Windows 7 SP1 — ships Chromium 108.
 *
 * This pass rewrites `<color-mix(in oklab, C p%, transparent)>` into the
 * `rgb(<triplet> / <alpha>)` form Chromium 65+ understands and hoists the rules
 * out of the guard. Mixing a color with `transparent` in a premultiplied space
 * keeps the color and scales its alpha by `p%`, so the rewrite is exact.
 *
 * A `var(--token)` operand cannot be decomposed at runtime before color-mix
 * exists, so the triplet is materialised next to the token's own definition
 * (`--token-rgb: r g b`) — the same block, so light and dark values stay
 * paired. Tokens whose value is not a literal color (a nested `var()`, `lab()`,
 * …) are left untouched rather than guessed.
 */

const COLOR_MIX_CALL = /color-mix\(\s*in\s+[\w-]+\s*,\s*(currentcolor|#[0-9a-fA-F]{3,8}|rgba?\([^()]*\)|var\(--[A-Za-z0-9_-]+\))\s*([\d.]+)%\s*,\s*transparent\s*\)/gu
const DECLARATION = /(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+)/gu
const TRIPLET_NAME = /(--[A-Za-z0-9_-]+?)-rgb$/
const UNPREFIXED_AT_RULES = /^@(?:keyframes|-webkit-keyframes|font-face|property|charset|import|namespace|page|counter-style|font-feature-values)\b/iu

interface ColorLiteral {
  readonly triplet: string
  readonly alpha: number
}

/** Parse a literal sRGB color; nested functions and non-literals return undefined. */
function parseColorLiteral(value: string): ColorLiteral | undefined {
  const hex = /^#([0-9a-fA-F]{3,8})$/u.exec(value.trim())
  if (hex?.[1] !== undefined) {
    const digits = hex[1]
    const expand = (part: string): number => Number.parseInt(part.length === 1 ? part + part : part, 16)
    if (digits.length === 3 || digits.length === 4) {
      const alpha = digits.length === 4 ? expand(digits[3] ?? 'f') / 255 : 1
      return { triplet: `${String(expand(digits[0] ?? ''))} ${String(expand(digits[1] ?? ''))} ${String(expand(digits[2] ?? ''))}`, alpha }
    }
    if (digits.length === 6 || digits.length === 8) {
      const alpha = digits.length === 8 ? expand(digits.slice(6, 8)) / 255 : 1
      return {
        triplet: `${String(expand(digits.slice(0, 2)))} ${String(expand(digits.slice(2, 4)))} ${String(expand(digits.slice(4, 6)))}`,
        alpha,
      }
    }
    return undefined
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/u.exec(value.trim())
  if (rgb?.[1] !== undefined && rgb[2] !== undefined && rgb[3] !== undefined) {
    const alpha = rgb[4] === undefined ? 1 : (rgb[4].endsWith('%') ? Number.parseFloat(rgb[4]) / 100 : Number.parseFloat(rgb[4]))
    const round = (part: string): number => Math.round(Number.parseFloat(part))
    return { triplet: `${String(round(rgb[1]))} ${String(round(rgb[2]))} ${String(round(rgb[3]))}`, alpha }
  }
  return undefined
}

/**
 * Literal colors declared in this stylesheet, keyed by custom property name.
 *
 * A token is usable only when *every* one of its definition sites is an opaque
 * literal color. The triplet carries no alpha, so a token that is itself
 * translucent (`--input: #ffffff26` in the dark theme) would otherwise pair a
 * dark triplet with a light-theme alpha. Those tokens keep their original
 * `color-mix()` declaration, whose Tailwind fallback is at worst the token's own
 * translucent value.
 */
function collectTokens(css: string): Map<string, ColorLiteral> {
  const sites = new Map<string, { literal: ColorLiteral | undefined, opaque: boolean, count: number }>()
  for (const match of css.matchAll(DECLARATION)) {
    const name = match[1]
    const value = match[2]
    if (name === undefined || value === undefined || TRIPLET_NAME.test(name)) continue
    const literal = parseColorLiteral(value)
    const site = sites.get(name) ?? { literal, opaque: literal?.alpha === 1, count: 0 }
    sites.set(name, {
      literal: site.literal ?? literal,
      opaque: site.opaque && literal?.alpha === 1,
      count: site.count + 1,
    })
  }
  const tokens = new Map<string, ColorLiteral>()
  for (const [name, site] of sites) {
    if (site.literal !== undefined && site.opaque) tokens.set(name, site.literal)
  }
  return tokens
}

/** Format an alpha the way the `rgb(r g b / a)` syntax expects it. */
function formatAlpha(alpha: number): string {
  return String(Number(alpha.toFixed(4)))
}

interface RewriteOutcome {
  readonly value: string
  /** Extra declaration needed when the operand is `currentcolor`. */
  readonly opacity?: number
}

function rewriteValue(property: string, value: string, tokens: Map<string, ColorLiteral>, used: Set<string>): RewriteOutcome {
  let opacity: number | undefined
  const rewritten = value.replace(COLOR_MIX_CALL, (call, operand: string, percent: string) => {
    const share = Number.parseFloat(percent) / 100
    if (operand === 'currentcolor') {
      if (property !== 'color') return call
      opacity = share
      return 'currentcolor'
    }
    const token = /^var\((--[A-Za-z0-9_-]+)\)$/u.exec(operand)
    if (token?.[1] !== undefined) {
      const literal = tokens.get(token[1])
      if (literal === undefined) return call
      used.add(token[1])
      return `rgb(var(${token[1]}-rgb) / ${formatAlpha(share)})`
    }
    const literal = parseColorLiteral(operand)
    if (literal === undefined) return call
    return `rgb(${literal.triplet} / ${formatAlpha(share * literal.alpha)})`
  })
  return opacity === undefined ? { value: rewritten } : { value: rewritten, opacity }
}

/** Rewrite every declaration of one rule body. */
function rewriteBody(body: string, tokens: Map<string, ColorLiteral>, used: Set<string>): string {
  if (!body.includes('color-mix(')) return body
  const declarations: string[] = []
  for (const part of body.split(';')) {
    const colon = part.indexOf(':')
    if (colon < 0) { declarations.push(part); continue }
    const property = part.slice(0, colon).trim()
    const outcome = rewriteValue(property, part.slice(colon + 1), tokens, used)
    declarations.push(`${part.slice(0, colon)}:${outcome.value}`)
    if (outcome.opacity !== undefined) declarations.push(` opacity: ${formatAlpha(outcome.opacity)}`)
  }
  return declarations.join(';')
}

/** Walk a stylesheet, hoisting color-mix guards and rewriting their declarations. */
function rewriteStylesheet(css: string, tokens: Map<string, ColorLiteral>, used: Set<string>): string {
  let out = ''
  let cursor = 0
  while (cursor < css.length) {
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
      if (/^@supports\b/iu.test(prelude) && prelude.includes('color-mix')) {
        // Chromium 108 fails this guard: keep the rules but drop the guard.
        out += rewriteStylesheet(body, tokens, used)
      } else if (UNPREFIXED_AT_RULES.test(prelude)) {
        out += `${prelude}{${body}}`
      } else {
        out += `${prelude}{${rewriteStylesheet(body, tokens, used)}}`
      }
    } else {
      out += `${prelude}{${rewriteBody(body, tokens, used)}}`
    }
    cursor = scan
  }
  return out
}

/** Add `<token>-rgb` next to every token definition a rewrite depends on. */
function injectTriplets(css: string, used: Set<string>): string {
  if (used.size === 0) return css
  const injectBody = (body: string): string => {
    const declarations: string[] = []
    for (const part of body.split(';')) {
      declarations.push(part)
      const match = /^\s*(--[A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/u.exec(part)
      const name = match?.[1]
      const value = match?.[2]
      if (name === undefined || value === undefined || !used.has(name) || TRIPLET_NAME.test(name)) continue
      const literal = parseColorLiteral(value)
      if (literal === undefined) continue
      declarations.push(` ${name}-rgb: ${literal.triplet}`)
    }
    return declarations.join(';')
  }
  return walkStylesheet(css, body => injectBody(body))
}

/** Walk every rule body of a stylesheet, leaving at-rule structure in place. */
function walkStylesheet(css: string, rewrite: (body: string) => string): string {
  let out = ''
  let cursor = 0
  while (cursor < css.length) {
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
    if (prelude.startsWith('@') && !UNPREFIXED_AT_RULES.test(prelude)) {
      out += `${prelude}{${walkStylesheet(body, rewrite)}}`
    } else {
      out += `${prelude}{${prelude.startsWith('@') ? body : rewrite(body)}}`
    }
    cursor = scan
  }
  return out
}

/**
 * Rewrite one stylesheet. Idempotent: a stylesheet without `color-mix(` and
 * without a guard is returned unchanged.
 */
export function legacyColorMix(css: string): string {
  if (!css.includes('color-mix(')) return css
  const tokens = collectTokens(css)
  const used = new Set<string>()
  const rewritten = rewriteStylesheet(css, tokens, used)
  return injectTriplets(rewritten, used)
}

/**
 * Apply the rewrite to every CSS asset a Vite build emits.
 *
 * Runs before other `generateBundle` handlers so passes that inline CSS into a
 * chunk (the onboarding installer) see the finished stylesheet.
 */
export function legacyColorMixPlugin(): Plugin {
  return {
    name: 'desktop-legacy-color-mix',
    enforce: 'post',
    generateBundle: { order: 'pre', handler(_options, bundle) {
      for (const asset of Object.values(bundle)) {
        if (asset.type !== 'asset' || !asset.fileName.endsWith('.css')) continue
        asset.source = legacyColorMix(String(asset.source))
      }
    } },
  }
}
