#!/usr/bin/env node
/** 校验 color-mix 展开是否损坏了 design-platform.css 的令牌声明。 */
import { readFileSync } from 'node:fs'

const CUR = 'E:/Desktop/DSHV3/src/deepseek-harness-master/packages/client/ui-theme/src/styles/design-platform.css'
const BAK = CUR + '.bak'

function props(text) {
  const list = []
  const re = /(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g
  let m
  while ((m = re.exec(text)) !== null) list.push({ name: m[1], value: m[2].trim() })
  return list
}

const curText = readFileSync(CUR, 'utf8')
const bakText = readFileSync(BAK, 'utf8')
const a = props(bakText)
const b = props(curText)

console.log(`备份声明 ${a.length} 条；当前声明 ${b.length} 条`)

const bakSet = new Map()
for (const p of a) bakSet.set(p.name, p.value)
const curSet = new Map()
for (const p of b) curSet.set(p.name, p.value)

const missing = []
const changed = []
for (const [k, v] of bakSet) {
  if (!curSet.has(k)) { missing.push(k); continue }
  const now = curSet.get(k)
  if (now !== v) {
    // 允许的变化只有两种展开形式
    const toMix = /^var\(--dsw-mix-\d+\)$/.test(now)
    const toRgb = /^rgb\(var\(--[A-Za-z0-9_-]+-rgb\) \/ [\d.]+\)$/.test(now)
    const wasColorMix = /^color-mix\(/.test(v)
    if (!((toMix || toRgb) && wasColorMix)) {
      changed.push(`${k}\n      旧: ${v.slice(0, 90)}\n      新: ${now.slice(0, 90)}`)
    }
  }
}

console.log(`丢失令牌: ${missing.length}` + (missing.length ? `\n  ${missing.join('\n  ')}` : ''))
console.log(`非预期变更: ${changed.length}` + (changed.length ? `\n  ${changed.join('\n  ')}` : ''))

// 新增的注入项统计
const injected = b.filter(p => /-rgb$/.test(p.name) || /^--dsw-mix-\d+$/.test(p.name))
console.log(`注入项: ${injected.length} 条（-rgb ${injected.filter(p => /-rgb$/.test(p.name)).length} / mix ${injected.filter(p => /^--dsw-mix-/.test(p.name)).length}）`)

// 未替换的真实声明（排除注释区）
const noComment = curText.replace(/\/\*[\s\S]*?\*\//g, '')
const left = noComment.match(/color-mix\(/g)
console.log(`注释外 color-mix 残留: ${left ? left.length : 0}`)

// 查找可疑的孤立 "-" 行
const lines = curText.split(/\r?\n/)
const suspicious = []
lines.forEach((l, i) => { if (/^\s*-\s*$/.test(l)) suspicious.push(i + 1) })
console.log(`孤立 "-" 行: ${suspicious.length ? suspicious.join(', ') : '无'}`)
if (suspicious.length) {
  for (const n of suspicious.slice(0, 3)) {
    console.log(`  行 ${n} 上下文:`)
    for (let i = Math.max(0, n - 3); i < Math.min(lines.length, n + 2); i++) {
      console.log(`    ${i + 1}: ${lines[i].slice(0, 100)}`)
    }
  }
}
