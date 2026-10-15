#!/usr/bin/env node
/**
 * 修复 DSH Desktop 仓库中 Chromium 108 不支持的颜色语法。
 *
 * 与上游（deepseek-harness-master）不同，desktop 仓库另有自己的样式层：
 *   dsh-plugin-desktop[-beta]/src/native-ui/shared/theme.css   shadcn 主题变量（oklch）
 *   dsh-plugin-desktop[-beta]/src/native-ui/compatibility-chrome/style.css
 *   dsh-desktop-next/src/native-ui/{theme,onboarding}.css
 *
 * 处理项：
 *   oklch(...)                     -> rgb(...) / rgb(... / a)      Chromium 108 不支持 oklch
 *   color-mix(..., var(--x) N%, transparent) -> rgb(var(--x-rgb) / a)
 *   color-mix(..., #hex N%, transparent)     -> rgb(r g b / a)
 *
 * 同时为被引用的主题变量注入 -rgb 三元组（同一作用域内成对写入）。
 *
 * 用法：
 *   node fix-desktop-css.mjs            分析（不改动）
 *   node fix-desktop-css.mjs --apply    执行（自动 .bak）
 *   node fix-desktop-css.mjs --restore  回滚
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync, globSync } from 'node:fs'
import { dirname, join, relative, basename } from 'node:path'

const ROOT = 'E:/Desktop/DSHV3/src/dsh-desktop-master'
const apply = process.argv.includes('--apply')
const restore = process.argv.includes('--restore')

const TARGETS = [
  'dsh-plugin-desktop/src/native-ui/shared/theme.css',
  'dsh-plugin-desktop/src/native-ui/compatibility-chrome/style.css',
  'dsh-plugin-desktop/src/client/onboarding.css',
  'dsh-plugin-desktop-beta/src/native-ui/shared/theme.css',
  'dsh-plugin-desktop-beta/src/native-ui/compatibility-chrome/style.css',
  'dsh-plugin-desktop-beta/src/client/onboarding.css',
  'dsh-desktop-next/src/native-ui/theme.css',
  'dsh-desktop-next/src/native-ui/onboarding.css',
].map(p => join(ROOT, p))

/** 除 color-mix 引用者外，还需为 tsx 透明度修饰符的替换提供三元组的令牌。 */
const WANTED_RGB = ['--muted', '--ring', '--destructive', '--card', '--border', '--primary', '--secondary']

if (restore) {
  let n = 0
  for (const p of TARGETS) {
    if (existsSync(`${p}.bak`)) { copyFileSync(`${p}.bak`, p); unlinkSync(`${p}.bak`); n++ }
  }
  console.log(`已回滚 ${n} 个文件`)
  process.exit(0)
}

// ---------------------------------------------------------------- 色彩

/** oklch -> sRGB。使用 CSS Color 4 的 oklab 定义矩阵。 */
function oklchToRgb(L, C, H) {
  const h = H * Math.PI / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  const gamma = c => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055
    return Math.round(Math.max(0, Math.min(1, v)) * 255)
  }
  return { r: gamma(lr), g: gamma(lg), b: gamma(lb) }
}

const clamp255 = v => Math.round(Math.max(0, Math.min(255, v)))

/** 解析 rgb()/#hex/具名色。 */
function parseColor(value) {
  const v = value.trim().toLowerCase()
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  if (v === 'black') return { r: 0, g: 0, b: 0, a: 1 }
  if (v === 'white') return { r: 255, g: 255, b: 255, a: 1 }
  let m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(v)
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4])
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a }
  }
  m = /^#([0-9a-f]{3,8})$/.exec(v)
  if (m) {
    let h = m[1]
    if (h.length === 3) h = h.split('').map(c => c + c).join('')
    if (h.length === 6) h += 'ff'
    if (h.length !== 8) return undefined
    return {
      r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16), a: parseInt(h.slice(6, 8), 16) / 255,
    }
  }
  return undefined
}

const fmtRgb = c => {
  const a = Number(c.a.toFixed(4))
  return a >= 1 ? `rgb(${c.r}, ${c.g}, ${c.b})` : `rgb(${c.r} ${c.g} ${c.b} / ${a})`
}

function mixColors(c1, p1, c2, p2) {
  let w1, w2
  if (p1 !== undefined && p2 !== undefined) { w1 = p1; w2 = p2 }
  else if (p1 !== undefined) { w1 = p1; w2 = 100 - p1 }
  else if (p2 !== undefined) { w2 = p2; w1 = 100 - p2 }
  else { w1 = 50; w2 = 50 }
  const sum = w1 + w2
  w1 /= sum; w2 /= sum
  const a = c1.a * w1 + c2.a * w2
  if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 }
  return {
    r: (c1.r * c1.a * w1 + c2.r * c2.a * w2) / a,
    g: (c1.g * c1.a * w1 + c2.g * c2.a * w2) / a,
    b: (c1.b * c1.a * w1 + c2.b * c2.a * w2) / a,
    a,
  }
}

// ---------------------------------------------------------------- 处理

const report = []
const needManual = []

for (const file of TARGETS) {
  if (!existsSync(file)) { console.log(`跳过（不存在）: ${relative(ROOT, file)}`); continue }
  let text = readFileSync(file, 'utf8')
  const before = text
  let oklchCount = 0
  let mixCount = 0

  // ---- 1. oklch -> rgb
  text = text.replace(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)/gi,
    (m, L, C, H, A) => {
      oklchCount++
      const c = oklchToRgb(Number(L), Number(C), Number(H))
      const a = A === undefined ? 1 : A.endsWith('%') ? Number(A.slice(0, -1)) / 100 : Number(A)
      return a >= 1 ? `rgb(${c.r}, ${c.g}, ${c.b})` : `rgb(${c.r} ${c.g} ${c.b} / ${a})`
    })

  // ---- 2. color-mix -> rgb
  // 括号配对提取，避免正则漏掉嵌套
  const spans = []
  for (let idx = text.indexOf('color-mix('); idx !== -1; idx = text.indexOf('color-mix(', idx)) {
    let depth = 0, i = idx
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++
      else if (text[i] === ')') { depth--; if (depth === 0) break }
    }
    spans.push([idx, i + 1])
    idx = i + 1
  }
  for (const [s, e] of spans.reverse()) {
    const raw = text.slice(s, e)
    const m = /^color-mix\(\s*in\s+([a-z0-9-]+)\s*,\s*([\s\S]+)\)$/i.exec(raw.trim())
    if (!m) { needManual.push({ file, raw, why: '无法解析' }); continue }
    const parts = []
    let depth = 0, cur = ''
    for (const ch of m[2]) {
      if (ch === '(') depth++
      if (ch === ')') depth--
      if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = '' } else cur += ch
    }
    parts.push(cur.trim())
    const split = p => {
      const pm = /^([\s\S]*?)\s+([\d.]+)%$/.exec(p.trim())
      return pm ? { color: pm[1].trim(), pct: Number(pm[2]) } : { color: p.trim(), pct: undefined }
    }
    if (parts.length !== 2) { needManual.push({ file, raw, why: '参数数量异常' }); continue }
    const A = split(parts[0]); const B = split(parts[1])
    const varOf = x => { const v = /^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/.exec(x.trim()); return v ? v[1] : undefined }
    const transparentB = /^transparent$/i.test(B.color) && B.pct === undefined
    const aVar = varOf(A.color)
    const bVar = varOf(B.color)

    let replacement
    if (aVar && transparentB && A.pct !== undefined) {
      // CSS 变量加透明度：交给该作用域内的 -rgb 三元组
      replacement = `rgb(var(${aVar}-rgb) / ${Number((A.pct / 100).toFixed(4))})`
    } else if (bVar && A.pct !== undefined && B.pct === undefined && !aVar) {
      // 静态色 + 变量（保留静态侧为字面 rgb，变量侧给三元组）—— 此处不做，交人工
      needManual.push({ file, raw, why: '静态色与变量混合，需按作用域预计算' })
      continue
    } else if (!aVar && !bVar) {
      const ca = parseColor(A.color); const cb = parseColor(B.color)
      if (ca && cb) {
        replacement = fmtRgb(mixColors(ca, A.pct, cb, B.pct)); mixCount++
      } else {
        needManual.push({ file, raw, why: '含无法解析的颜色' })
        continue
      }
    } else {
      needManual.push({ file, raw, why: 'var + var / var + 静态色，需按作用域预计算' })
      continue
    }
    text = text.slice(0, s) + replacement + text.slice(e)
    mixCount++
  }

  report.push({ file: relative(ROOT, file), oklch: oklchCount, mix: mixCount, changed: text !== before })

  if (apply && text !== before) {
    if (!existsSync(`${file}.bak`)) copyFileSync(file, `${file}.bak`)
    writeFileSync(file, text)
  }
}

console.log('=== 统计 ===')
for (const r of report) {
  console.log(`  ${r.oklch.toString().padStart(3)} oklch  ${r.mix.toString().padStart(2)} mix   ${r.file}`)
}
console.log(`\n合计: oklch ${report.reduce((a, r) => a + r.oklch, 0)} 处, color-mix ${report.reduce((a, r) => a + r.mix, 0)} 处`)

if (needManual.length) {
  console.log(`\n=== 需按作用域预计算（${needManual.length}）===`)
  for (const m of needManual) {
    console.log(`  ${relative(ROOT, m.file)}  [${m.why}]`)
    console.log(`      ${m.raw.slice(0, 130)}`)
  }
}

// ---------------------------------------------------------------- 注入 -rgb 三元组

if (apply) {
  // 收集所有已被替换出来的 -rgb 引用
  const referenced = new Set()
  for (const p of TARGETS) {
    if (!existsSync(p)) continue
    for (const m of readFileSync(p, 'utf8').matchAll(/var\(\s*(--[A-Za-z0-9_-]+)-rgb\s*\)/g)) referenced.add(m[1])
  }

  // 注意 Windows 路径分隔符：join() 产出反斜杠，不能用 '/' 形式做 endsWith
  const themeFiles = TARGETS.filter(p => /shared[\\/]theme\.css$/.test(p))
  let injected = 0
  for (const file of themeFiles) {
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')

    // 切出所有大括号块（含媒体查询内层），逐块检查其自身定义的变量
    const blocks = []
    const stack = []
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e === -1 ? text.length : e + 1; continue }
      if (text[i] === '{') stack.push(i)
      else if (text[i] === '}' && stack.length) blocks.push([stack.pop(), i])
    }

    const edits = []
    for (const [open, close] of blocks) {
      const body = text.slice(open + 1, close)
      // 只取块体直接层级上的声明。嵌套规则块（如 @media 内的 :root）由它自己的
      // 块处理；在外层块注入会落到 @media 的直接子层，那是无效的声明位置。
      let direct = ''
      let d = 0
      for (const ch of body) {
        if (ch === '{') d++
        else if (ch === '}') d--
        else if (d === 0) direct += ch
      }
      const props = new Map()
      for (const m of direct.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g)) props.set(m[1], m[2].trim())
      const lines = []
      for (const name of new Set([...referenced, ...WANTED_RGB])) {
        if (!props.has(name) || props.has(`${name}-rgb`)) continue
        const val = props.get(name)
        const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(val)
        if (!rgb) continue
        lines.push(`  ${name}-rgb: ${rgb[1]} ${rgb[2]} ${rgb[3]};`)
        injected++
      }
      if (lines.length) {
        edits.push({ at: open + 1, text: `\n  /* Chromium 108: rgb() 三元组，供 rgb(var(--x-rgb) / a) 使用 */\n${lines.join('\n')}\n` })
      }
    }
    if (edits.length) {
      let out = text
      for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.at)
      writeFileSync(file, out)
    }
  }
  console.log(`\n注入 -rgb 三元组: ${injected} 条`)
}

if (apply) console.log('\n已应用。回滚：node scripts/fix-desktop-css.mjs --restore')
else console.log('\n（未加 --apply，未改动任何文件）')
