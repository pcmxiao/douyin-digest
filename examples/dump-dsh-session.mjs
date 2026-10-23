import { zstdDecompressSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'

const f = process.argv[2]
if (!f) {
  console.error('用法: node dump-session2.mjs <session.v4.jsonl.zstd>')
  process.exit(1)
}

const buf = readFileSync(f)
console.log('文件大小:', buf.length, '字节')

// zstd frame 魔数: 0x28 0xB5 0x2F 0xFD
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const starts = []
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) {
    starts.push(i)
  }
}
console.log('找到', starts.length, '个 frame')

let text = ''
let ok = 0
for (let i = 0; i < starts.length; i++) {
  const from = starts[i]
  const to = i + 1 < starts.length ? starts[i + 1] : buf.length
  const slice = buf.subarray(from, to)
  try {
    text += zstdDecompressSync(slice).toString('utf8')
    ok++
  } catch {
    // 这个 slice 可能包含了不可切分的内容，跳过
  }
}

const lines = text.split('\n').filter(Boolean)
console.log(`解出 ${ok} 个 frame，共 ${text.length} 字符，${lines.length} 行`)
console.log('')

const types = {}
for (const line of lines) {
  try {
    const j = JSON.parse(line)
    const t = j.type || j.kind || '?'
    types[t] = (types[t] || 0) + 1
  } catch { /* 忽略 */ }
}
console.log('事件类型:', JSON.stringify(types))
console.log('')

// 打印有内容的事件
let shown = 0
for (const line of lines) {
  if (shown >= 10) break
  try {
    const j = JSON.parse(line)
    if (j.type === 'session') { console.log('[session]', JSON.stringify(j).slice(0, 200)); shown++; continue }
    console.log('---', j.type || j.kind)
    console.log(JSON.stringify(j).slice(0, 400))
    shown++
  } catch { /* 忽略 */ }
}

writeFileSync(f.replace(/\.zstd$/, '.all.jsonl'), text, 'utf8')
console.log('')
console.log('已写:', f.replace(/\.zstd$/, '.all.jsonl'))
