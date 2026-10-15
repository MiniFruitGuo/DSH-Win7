import { describe, expect, it } from 'vitest'
import { legacyColorMix } from '../scripts/legacy-color-mix.ts'

const GUARD = '@supports (color:color-mix(in lab, red, red))'

describe('legacyColorMix', () => {
  it('hoists a guarded Tailwind opacity rule and resolves a token operand', () => {
    const css = `:root{--color-black:#000}`
      + `@supports (color:color-mix(in lab, red, red)){.bg-black\\/30{background-color:color-mix(in oklab, var(--color-black) 30%, transparent)}}`
    const rewritten = legacyColorMix(css)
    expect(rewritten).not.toContain(GUARD)
    expect(rewritten).toContain('.bg-black\\/30{background-color:rgb(var(--color-black-rgb) / 0.3)}')
    expect(rewritten).toContain('--color-black-rgb: 0 0 0')
  })

  it('resolves a literal operand without any token', () => {
    const css = `@supports (color:color-mix(in lab, red, red)){.x{box-shadow:0 1px 2px color-mix(in srgb, #000 28%, transparent)}}`
    expect(legacyColorMix(css)).toBe('.x{box-shadow:0 1px 2px rgb(0 0 0 / 0.28)}')
  })

  it('materialises the triplet next to the token definition it belongs to', () => {
    const css = `:root{--destructive:#e7000b}.dark{--destructive:#ff6467}`
      + `@supports (color:color-mix(in lab, red, red)){.bg-destructive\\/10{background-color:color-mix(in oklab, var(--destructive) 10%, transparent)}}`
    const rewritten = legacyColorMix(css)
    expect(rewritten).toContain('.bg-destructive\\/10{background-color:rgb(var(--destructive-rgb) / 0.1)}')
    expect(rewritten).toContain('--destructive-rgb: 231 0 11')
    expect(rewritten).toContain('--destructive-rgb: 255 100 103')
  })

  it('leaves a token untouched when any definition carries its own alpha', () => {
    const css = `:root{--input:#e5e5e5}`
      + `@media (prefers-color-scheme:dark){:root{--input:#ffffff26}}`
      + `@supports (color:color-mix(in lab, red, red)){.bg-input\\/90{background-color:color-mix(in oklab, var(--input) 90%, transparent)}}`
    const rewritten = legacyColorMix(css)
    // A triplet cannot carry the dark theme's 15% alpha, so the declaration keeps
    // its color-mix form and Tailwind's own fallback.
    expect(rewritten).toContain('background-color:color-mix(in oklab, var(--input) 90%, transparent)')
    expect(rewritten).not.toContain('--input-rgb')
  })

  it('carries an alpha written on a literal operand into the rewritten alpha', () => {
    const css = `@supports (color:color-mix(in lab, red, red)){.x{background-color:color-mix(in oklab, #00000080 50%, transparent)}}`
    expect(legacyColorMix(css)).toContain('background-color:rgb(0 0 0 / 0.251)')
  })

  it('renders a currentcolor placeholder as color plus opacity', () => {
    const css = `@supports (color:color-mix(in lab, red, red)){::placeholder{color:color-mix(in oklab, currentcolor 50%, transparent)}}`
    const rewritten = legacyColorMix(css)
    expect(rewritten).toContain('::placeholder{color:currentcolor; opacity: 0.5}')
  })

  it('leaves an operand it cannot decompose untouched', () => {
    const css = `:root{--brand:var(--brand-source)}`
      + `@supports (color:color-mix(in lab, red, red)){.bg-brand\\/10{background-color:color-mix(in oklab, var(--brand) 10%, transparent)}}`
    const rewritten = legacyColorMix(css)
    expect(rewritten).toContain('color-mix(in oklab, var(--brand) 10%, transparent)')
    expect(rewritten).not.toContain('--brand-rgb')
  })

  it('keeps the rule order of the guard it replaces', () => {
    const css = `a{color:red}`
      + `@supports (color:color-mix(in lab, red, red)){.x{background-color:color-mix(in oklab, #fff 50%, transparent)}}`
      + `b{color:blue}`
    expect(legacyColorMix(css)).toBe('a{color:red}.x{background-color:rgb(255 255 255 / 0.5)}b{color:blue}')
  })

  it('is idempotent', () => {
    const css = `:root{--muted:#f5f5f5}`
      + `@supports (color:color-mix(in lab, red, red)){.bg-muted\\/20{background-color:color-mix(in oklab, var(--muted) 20%, transparent)}}`
    const once = legacyColorMix(css)
    expect(legacyColorMix(once)).toBe(once)
  })
})
