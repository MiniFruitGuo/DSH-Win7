const { readFileSync } = require('node:fs')
const p = 'E:/Desktop/DSHV3/src/dsh-desktop-master/dsh-plugin-desktop-beta/src/native-ui/shared/theme.css'
const t = readFileSync(p, 'utf8')
const refs = [...t.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)-rgb\s*\)/g)].map(m => m[1])
console.log('referenced =', JSON.stringify(refs))
const blocks = []
const stack = []
for (let i = 0; i < t.length; i++) {
  if (t[i] === '/' && t[i+1] === '*') { const e = t.indexOf('*/', i+2); i = e === -1 ? t.length : e + 1; continue }
  if (t[i] === '{') stack.push(i)
  else if (t[i] === '}' && stack.length) blocks.push([stack.pop(), i])
}
console.log('blocks =', blocks.length)
for (const [open, close] of blocks) {
  const body = t.slice(open+1, close)
  const props = [...body.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g)].map(m => m[1])
  const hit = props.filter(x => refs.includes(x))
  console.log('  span', open, close, 'props', props.length, 'matched', JSON.stringify(hit))
}