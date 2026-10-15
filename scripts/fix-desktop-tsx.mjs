#!/usr/bin/env node
/**
 * 把 DSH Desktop 中 Tailwind v4 的透明度修饰符改写为 Chromium 108 可用的形式。
 *
 * 背景：Tailwind v4 一律用 color-mix() 实现 `bg-x/NN` 透明度修饰符（最低 Chromium 111），
 * Electron 22 只提供 Chromium 108。v4 没有开关可以改用旧语法，因此改写调用点。
 *
 * 映射到 rgb(var(--token-rgb) / a)：三元组由 theme.css 在同一作用域提供。
 * Tailwind 内置色（amber-500）未走主题变量，直接内联其 sRGB 值。
 *
 * 用法：
 *   node fix-desktop-tsx.mjs            分析
 *   node fix-desktop-tsx.mjs --apply    执行
 *   node fix-desktop-tsx.mjs --restore  回滚
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync, globSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = 'E:/Desktop/DSHV3/src/dsh-desktop-master'
const apply = process.argv.includes('--apply')
const restore = process.argv.includes('--restore')

// Tailwind 内置调色板未走主题变量，其 sRGB 值直接内联
const AMBER_500 = '245_158_11'

const MAP = new Map([
  ['ring-ring/30', 'ring-[rgb(var(--ring-rgb)/0.3)]'],
  ['ring-ring/50', 'ring-[rgb(var(--ring-rgb)/0.5)]'],
  ['bg-muted/20', 'bg-[rgb(var(--muted-rgb)/0.2)]'],
  ['bg-muted/30', 'bg-[rgb(var(--muted-rgb)/0.3)]'],
  ['bg-muted/40', 'bg-[rgb(var(--muted-rgb)/0.4)]'],
  ['bg-muted/70', 'bg-[rgb(var(--muted-rgb)/0.7)]'],
  ['bg-background/80', 'bg-[rgb(var(--background-rgb)/0.8)]'],
  ['bg-amber-500/10', `bg-[rgb(${AMBER_500}/0.1)]`],
  ['border-amber-500/30', `border-[rgb(${AMBER_500}/0.3)]`],
  ['border-amber-500/40', `border-[rgb(${AMBER_500}/0.4)]`],
  ['border-amber-500/50', `border-[rgb(${AMBER_500}/0.5)]`],
  ['border-destructive/40', 'border-[rgb(var(--destructive-rgb)/0.4)]'],
])

const TSX_DIRS = [
  'dsh-plugin-desktop/src/native-ui',
  'dsh-plugin-desktop-beta/src/native-ui',
  'dsh-desktop-next/src/native-ui',
]
const CSS_FILES = [
  'dsh-plugin-desktop/src/native-ui/shared/theme.css',
  'dsh-plugin-desktop/src/client/onboarding.css',
  'dsh-plugin-desktop-beta/src/native-ui/shared/theme.css',
  'dsh-plugin-desktop-beta/src/client/onboarding.css',
]

function walk() {
  const files = []
  for (const d of TSX_DIRS) {
    const abs = join(ROOT, d).replace(/\\/g, '/')
    if (existsSync(abs)) files.push(...globSync(`${abs}/**/*.tsx`))
  }
  return files
}

if (restore) {
  let n = 0
  for (const p of [...walk(), ...CSS_FILES.map(f => join(ROOT, f))]) {
    if (existsSync(`${p}.bak`)) { copyFileSync(`${p}.bak`, p); unlinkSync(`${p}.bak`); n++ }
  }
  console.log(`已回滚 ${n} 个文件`)
  process.exit(0)
}

const files = [...walk(), ...CSS_FILES.map(f => join(ROOT, f))].filter(p => existsSync(p))
let totalHits = 0
const detail = []

for (const file of files) {
  let text = readFileSync(file, 'utf8')
  const before = text
  let hits = 0

  // 类名替换：要求前后不是标识符/斜杠字符，避免命中更长类名
  for (const [from, to] of MAP) {
    const re = new RegExp(`(?<![\\w/-])${from.replace(/[/\\-]/g, m => '\\' + m)}(?![\\w/-])`, 'g')
    const found = text.match(re)
    if (found) { hits += found.length; text = text.replace(re, to) }
  }

  // @apply 里的 outline-ring/50 -> 显式 outline-color
  const applyRe = /@apply\s+([^;]*?)outline-ring\/50([^;]*?);/g
  const applyFound = text.match(applyRe)
  if (applyFound) {
    hits += applyFound.length
    text = text.replace(applyRe, (_m, pre, post) => {
      const keep = `${pre}${post}`.trim()
      const head = keep ? `@apply ${keep}; ` : ''
      return `${head}outline-color: rgb(var(--ring-rgb) / 0.5);`
    })
  }

  if (text !== before) {
    detail.push({ file: relative(ROOT, file), hits })
    totalHits += hits
    if (apply) {
      if (!existsSync(`${file}.bak`)) copyFileSync(file, `${file}.bak`)
      writeFileSync(file, text)
    }
  }
}

console.log(apply ? '=== 已应用 ===' : '=== 分析（未改动）===')
for (const d of detail) console.log(`  ${String(d.hits).padStart(2)}  ${d.file}`)
console.log(`\n合计替换 ${totalHits} 处，涉及 ${detail.length} 个文件`)
if (apply) console.log('回滚：node scripts/fix-desktop-tsx.mjs --restore')
