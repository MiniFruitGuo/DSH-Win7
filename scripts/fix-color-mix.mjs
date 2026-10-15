#!/usr/bin/env node
/**
 * 将 Chromium 108 不支持的 color-mix() 展开为等价老语法。
 *
 * 背景：DSH 前端使用 color-mix()（最低 Chromium 111），而 Windows 7 SP1 上的
 * Electron 22 只提供 Chromium 108。
 *
 * 可行性依据（实测）：设计令牌最底层全部是静态 rgb() 字面值，别名令牌只是
 * var() 引用链，因此每个主题块内的颜色都能递归求值到确定值，color-mix 可在
 * 构建期完整展开，无需运行时支持。
 *
 * 展开规则：
 *   color-mix(in srgb, var(--x) A%, transparent)  ->  rgb(var(--x-rgb) / A/100)
 *   color-mix(in srgb, var(--a) A%, var(--b) B%)  ->  var(--dsw-mix-N)   每主题块一份值
 *
 * 实现要点：替换按扫描得到的字节偏移进行（从后向前），而不是正则文本匹配 ——
 * 正则匹配在文件已被改写后会错位并吃掉相邻声明的前缀。
 *
 * 用法：
 *   node fix-color-mix.mjs                 分析并输出报告（不改动文件）
 *   node fix-color-mix.mjs --apply         执行替换（自动备份 .bak）
 *   node fix-color-mix.mjs --restore       从 .bak 回滚
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, globSync, unlinkSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = 'E:/Desktop/DSHV3/src/deepseek-harness-master'
const THEME_FILE = join(ROOT, 'packages/client/ui-theme/src/styles/design-platform.css')
const SCAN_DIRS = ['packages/client', 'packages/web', 'apps/web', 'packages/host']
const apply = process.argv.includes('--apply')
const restore = process.argv.includes('--restore')

// ---------------------------------------------------------------- 回滚

if (restore) {
  let n = 0
  const walk = dir => {
    for (const e of globSafe(dir)) {
      if (e.endsWith('.bak')) {
        copyFileSync(e, e.slice(0, -4))
        unlinkSync(e)
        n++
      }
    }
  }
  walk(ROOT)
  console.log(`已从 .bak 回滚 ${n} 个文件`)
  process.exit(0)
}

function globSafe(dir) {
  try {
    return globSync(`${dir.replace(/\\/g, '/')}/**/*.{css,bak}`, {
      exclude: p => /node_modules|\\lib\\|\\dist\\/.test(p),
    })
  } catch { return [] }
}

// ---------------------------------------------------------------- CSS 解析

function topLevelBlocks(text) {
  const blocks = []
  let depth = 0
  let selStart = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (text[i] === '{') {
      if (depth === 0) blocks.push({ selector: strip(text.slice(selStart, i)), openIndex: i })
      depth++
    } else if (text[i] === '}') {
      depth--
      if (depth === 0) blocks[blocks.length - 1].closeIndex = i
      selStart = i + 1
    }
  }
  return blocks.filter(b => b.closeIndex !== undefined)
}

const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').trim()

function customProps(body) {
  const list = []
  const re = /(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g
  let m
  while ((m = re.exec(body)) !== null) list.push({ name: m[1], value: strip(m[2]) })
  return list
}

// ---------------------------------------------------------------- 颜色

const NAMED = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
}

function parseColor(value) {
  const v = value.trim().toLowerCase()
  if (!v) return undefined
  if (v in NAMED) return { ...NAMED[v] }
  let m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(v)
  if (m) {
    const alpha = m[4] === undefined ? 1
      : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4])
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: alpha }
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

const fmt = c => {
  const r = Math.round(c.r), g = Math.round(c.g), b = Math.round(c.b)
  const a = Number(c.a.toFixed(4))
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgb(${r} ${g} ${b} / ${a})`
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

// ---------------------------------------------------------------- 表达式

function parseColorMix(raw) {
  const m = /^color-mix\(\s*in\s+([a-z0-9-]+)\s*,\s*([\s\S]+)\)$/i.exec(raw.trim())
  if (!m) return undefined
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
  return { space: m[1].toLowerCase(), parts: parts.map(split) }
}

const varName = e => {
  const m = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,[\s\S]*)?\)$/.exec(e.trim())
  return m ? m[1] : undefined
}

function evalExpr(expr, table, seen = new Set()) {
  const e = expr.trim()
  const direct = parseColor(e)
  if (direct) return direct
  const name = varName(e)
  if (name) {
    if (seen.has(name)) return undefined
    seen.add(name)
    const value = table.get(name)
    if (value === undefined) return undefined
    return evalExpr(value, table, seen)
  }
  const cm = parseColorMix(e)
  if (cm) {
    const [A, B] = cm.parts
    if (!A || !B) return undefined
    const ca = evalExpr(A.color, table, new Set(seen))
    const cb = evalExpr(B.color, table, new Set(seen))
    if (!ca || !cb) return undefined
    return mixColors(ca, A.pct, cb, B.pct)
  }
  return undefined
}

/** 括号配对提取 color-mix(...)，返回含字节偏移的对象。 */
function extractColorMix(text) {
  const out = []
  let idx = 0
  for (;;) {
    idx = text.indexOf('color-mix(', idx)
    if (idx === -1) break
    let depth = 0, i = idx
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++
      else if (text[i] === ')') { depth--; if (depth === 0) break }
    }
    out.push({ raw: text.slice(idx, i + 1), start: idx, end: i + 1 })
    idx = i + 1
  }
  return out
}

// ---------------------------------------------------------------- 载入

const themeText0 = readFileSync(THEME_FILE, 'utf8')
const themeBlocks0 = topLevelBlocks(themeText0).filter(b => b.selector.includes('body'))

console.log(`主题块 ${themeBlocks0.length} 个:`)
const themeTables = new Map()
for (let i = 0; i < themeBlocks0.length; i++) {
  const b = themeBlocks0[i]
  const props = customProps(themeText0.slice(b.openIndex + 1, b.closeIndex))
  themeTables.set(i, new Map(props.map(p => [p.name, p.value])))
  console.log(`  [${i}] ${b.selector}  (${props.length} 个属性)`)
}

const allCss = []
for (const dir of SCAN_DIRS) {
  const abs = join(ROOT, dir).replace(/\\/g, '/')
  if (existsSync(abs)) {
    allCss.push(...globSync(`${abs}/**/*.css`, { exclude: p => /node_modules|\\lib\\|\\dist\\/.test(p) }))
  }
}

const extraTokens = new Map()
for (const f of allCss) {
  for (const p of customProps(readFileSync(f, 'utf8'))) {
    if (!extraTokens.has(p.name)) extraTokens.set(p.name, p.value)
  }
}

const evalTables = []
for (let i = 0; i < themeBlocks0.length; i++) {
  const merged = new Map(themeTables.get(i))
  for (const [k, v] of extraTokens) if (!merged.has(k)) merged.set(k, v)
  evalTables.push(merged)
}

// ---------------------------------------------------------------- 分析

const perFile = new Map()   // file -> [{raw,start,end,replacement,tokens}]
let total = 0

for (const f of allCss) {
  const text = readFileSync(f, 'utf8')
  const items = []
  for (const occ of extractColorMix(text)) {
    total++
    const cm = parseColorMix(occ.raw)
    if (!cm) continue
    const [A, B] = cm.parts
    const aName = varName(A.color)
    const bIsTransparent = /^transparent$/i.test(B.color)

    // 形态一：rgb(var(--x-rgb) / a)
    if (aName && bIsTransparent && A.pct !== undefined) {
      const values = evalTables.map(t => evalExpr(A.color, t))
      if (values.every(v => v)) {
        items.push({
          ...occ, kind: 'rgb', token: aName,
          alpha: Number((A.pct / 100).toFixed(4)), values,
          replacement: `rgb(var(${aName}-rgb) / ${Number((A.pct / 100).toFixed(4))})`,
        })
        continue
      }
    }

    // 形态二：派生令牌
    const values = evalTables.map(t => evalExpr(occ.raw, t))
    if (values.every(v => v)) {
      items.push({ ...occ, kind: 'mix', values, replacement: null })   // 编号在应用阶段分配
    } else {
      items.push({ ...occ, kind: 'unresolved', values })
    }
  }
  if (items.length) perFile.set(f, items)
}

const all = [...perFile.values()].flat()
const byKind = k => all.filter(x => x.kind === k)
console.log(`\ncolor-mix 总数: ${total}`)
console.log(`  rgb(var(--x-rgb)/a) : ${byKind('rgb').length}`)
console.log(`  派生令牌 --dsw-mix-N : ${byKind('mix').length}`)
console.log(`  求值失败            : ${byKind('unresolved').length}`)

const needRgb = new Map()
for (const t of byKind('rgb')) if (!needRgb.has(t.token)) needRgb.set(t.token, t.values)
console.log(`需 -rgb 的令牌: ${needRgb.size}`)

if (!apply) {
  console.log('\n（未加 --apply，未改动任何文件）')
  process.exit(0)
}

// ---------------------------------------------------------------- 应用

// 给每条 mix 分配稳定编号
byKind('mix').forEach((d, i) => { d.mixName = `--dsw-mix-${i + 1}`; d.replacement = `var(${d.mixName})` })

// 第一遍：按字节偏移替换（从后向前，避免偏移失效）
let replacedCount = 0
for (const [file, items] of perFile) {
  const usable = items.filter(x => x.replacement)
  if (!usable.length) continue
  let text = readFileSync(file, 'utf8')
  for (const it of [...usable].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, it.start) + it.replacement + text.slice(it.end)
    replacedCount++
  }
  if (!existsSync(`${file}.bak`)) copyFileSync(file, `${file}.bak`)
  writeFileSync(file, text)
}
console.log(`\n第一遍：按偏移替换 ${replacedCount} 处，覆盖 ${[...perFile.keys()].length} 个文件`)

// 第二遍：重新读取（已被替换的）主题文件，重新解析块，注入 -rgb 与派生令牌
const themeText = readFileSync(THEME_FILE, 'utf8')
const themeBlocks = topLevelBlocks(themeText).filter(b => b.selector.includes('body'))
const tables2 = themeBlocks.map(b =>
  new Map(customProps(themeText.slice(b.openIndex + 1, b.closeIndex)).map(p => [p.name, p.value])))

// 重建求值表（令牌值未变，仍可求值）
const evalTables2 = tables2.map(t => {
  const m = new Map(t)
  for (const [k, v] of extraTokens) if (!m.has(k)) m.set(k, v)
  return m
})

let rgbCount = 0
let mixCount = 0
const injects = []
for (let i = 0; i < themeBlocks.length; i++) {
  const b = themeBlocks[i]
  const lines = []
  // -rgb：只在该块自身定义了源令牌时注入，保证与源令牌同层叠
  for (const [name] of needRgb) {
    if (!tables2[i].has(name) || tables2[i].has(`${name}-rgb`)) continue
    const v = evalExpr(`var(${name})`, evalTables2[i])
    if (!v) continue
    lines.push(`  ${name}-rgb: ${Math.round(v.r)} ${Math.round(v.g)} ${Math.round(v.b)};`)
    rgbCount++
  }
  injects.push({ at: b.openIndex + 1, lines: [...lines], kind: 'rgb' })

  // 派生令牌：每个块按本块求值注入一份
  const mixLines = byKind('mix').map(d => `  ${d.mixName}: ${fmt(d.values[i])};`)
  injects.push({ at: b.openIndex + 1, lines: mixLines, kind: 'mix' })
  mixCount += mixLines.length
}

let out = themeText
for (const inj of injects.sort((a, b) => b.at - a.at)) {
  if (!inj.lines.length) continue
  const header = inj.kind === 'rgb'
    ? '  /* Chromium 108: rgb() 三元组，供 rgb(var(--x-rgb) / a) 使用 */'
    : '  /* Chromium 108: color-mix 展开值（按本主题块求值） */'
  out = out.slice(0, inj.at) + `\n${header}\n${inj.lines.join('\n')}\n` + out.slice(inj.at)
}
if (!existsSync(`${THEME_FILE}.bak`)) copyFileSync(THEME_FILE, `${THEME_FILE}.bak`)
writeFileSync(THEME_FILE, out)

console.log(`第二遍：注入 ${rgbCount} 条 -rgb、${mixCount} 条派生令牌`)
console.log(`\n完成。回滚：node scripts/fix-color-mix.mjs --restore`)
