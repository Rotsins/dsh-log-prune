#!/usr/bin/env node
// 修复被写坏的会话：删掉没有消息 id 的 user/message 事件，以及引用它们的 compaction/prune 孤儿事件。
// 用法：
//   node bin/repair-session.mjs <会话id 或 会话目录> [--dry]
// 先跑 --dry 看会删几条；不带 --dry 会先备份 .bak-<时间> 再改。
import { existsSync, readdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { zstdDecompressSync, zstdCompressSync } from 'node:zlib'
import { decompress as fzstdDecompress } from '../lib/vendor/fzstd.mjs'

const HOME = process.env.DSH_HOME || '~/.dsh'
const SESSIONS = join(HOME, 'sessions')
const arg = process.argv[2]
const dry = process.argv.includes('--dry')
if (!arg) { console.error('用法：repair-session.mjs <会话id 或 会话目录> [--dry]'); process.exit(2) }

function findDir(a) {
  if (existsSync(join(a, 'session.v4.jsonl.zstd'))) return a
  if (!existsSync(SESSIONS)) return null
  for (const ws of readdirSync(SESSIONS)) {
    const p = join(SESSIONS, ws, a)
    if (existsSync(join(p, 'session.v4.jsonl.zstd'))) return p
  }
  return null
}
const dir = findDir(arg)
if (!dir) { console.error('找不到会话目录：' + arg); process.exit(2) }
const file = join(dir, 'session.v4.jsonl.zstd')
console.log('会话目录：' + dir)

let raw = null
// 多帧日志：先上纯 JS 解码器（逐帧解全），再考虑 Node 内置/系统命令
try { raw = Buffer.from(fzstdDecompress(readFileSync(file))) } catch {}
if (!raw && typeof zstdDecompressSync === 'function') {
  try { raw = zstdDecompressSync(readFileSync(file)) } catch {}
}
if (!raw) {
  const dec = spawnSync('zstd', ['-dc', file], { maxBuffer: 1 << 30, windowsHide: true })
  if (dec.status === 0) raw = dec.stdout
}
if (!raw) {
  try { raw = Buffer.from(fzstdDecompress(readFileSync(file))) } catch {}
}
if (!raw) { console.error('解压失败：既没有系统 zstd，也没有可用的内置解码'); process.exit(2) }
const lines = raw.toString('utf8').split('\n').filter(Boolean)
const events = []
for (const line of lines) {
  try { events.push(JSON.parse(line)) } catch { events.push(null) }
}

const dropped = new Set()
const bad = []
events.forEach((ev, i) => {
  if (!ev) { bad.push({ i, why: '无法解析的行' }); dropped.add('line:' + i); return }
  if (ev.type === 'user/message') {
    const msg = ev.data?.message ?? ev.data
    if (!msg || typeof msg.id !== 'string' || msg.id === '') {
      bad.push({ i, seq: ev.seq, why: 'user/message 缺消息 id' }); dropped.add(ev.seq)
    }
  }
})
// 再删引用坏事件的孤儿 prune 事件
const out = []
for (let i = 0; i < events.length; i++) {
  const ev = events[i]
  const isBadLine = dropped.has('line:' + i)
  const isDroppedSeq = ev && dropped.has(ev.seq)
  let orphanPrune = false
  if (ev && ev.type === 'compaction/prune') {
    const seqs = ev.data?.shadowedSeqs || []
    if (seqs.some((s) => dropped.has(s))) orphanPrune = true
  }
  if (isBadLine || isDroppedSeq || orphanPrune) { out.push(null); continue }
  out.push(ev)
}
const kept = out.filter(Boolean)
console.log('坏事件：' + bad.length + (bad.length ? '（' + bad.map((b) => b.seq ?? b.why).join(', ') + '）' : ''))
console.log('保留事件：' + kept.length + ' / 原 ' + events.length)
if (dry) { console.log('dry：没有写文件'); process.exit(0) }
if (!bad.length) { console.log('没有要修的，未改动'); process.exit(0) }

const bak = file + '.bak-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
copyFileSync(file, bak)
const text = kept.map((e) => JSON.stringify(e)).join('\n') + '\n'
if (typeof zstdCompressSync === 'function') {
  writeFileSync(file, zstdCompressSync(Buffer.from(text)))
} else {
  const enc = spawnSync('zstd', ['-19', '-T0', '-q', '-f', '-o', file], { input: text, maxBuffer: 1 << 30, windowsHide: true })
  if (enc.status !== 0) { console.error('压缩失败：系统没有 zstd 且当前 Node 不支持 zstd 压缩，请先装 zstd'); process.exit(2) }
}
console.log('已修复，原文件备份：' + bak)