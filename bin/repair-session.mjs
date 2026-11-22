#!/usr/bin/env node
// 修复被写坏的会话：删掉没有消息 id 的 user/message 事件，以及引用它们的 compaction/prune 孤儿事件。
// 用法：
//   node bin/repair-session.mjs <会话id 或 会话目录> [--dry]
// 先跑 --dry 看会删几条；不带 --dry 会先备份 .bak-<时间> 再改。
import { existsSync, readdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'

const { zstdCompressSync } = zlib
// 2026-11-20 R2-H5：统一多帧安全解码（fzstd → CLI → 内置）
import { unzstd } from '../lib/zstd-safe.mjs'
import { sessionFileName } from '../lib/session-file.mjs'

import { resolveHome } from '../lib/home.mjs'
const HOME = resolveHome()
const SESSIONS = join(HOME, 'sessions')
const arg = process.argv[2]
const dry = process.argv.includes('--dry')
if (!arg) { console.error('用法：repair-session.mjs <会话id 或 会话目录> [--dry]'); process.exit(2) }

function findDir(a) {
  if (existsSync(join(a, sessionFileName(a)))) return a
  if (!existsSync(SESSIONS)) return null
  for (const ws of readdirSync(SESSIONS)) {
    const p = join(SESSIONS, ws, a)
    if (existsSync(join(p, sessionFileName(p)))) return p
  }
  return null
}
const dir = findDir(arg)
if (!dir) { console.error('找不到会话目录：' + arg); process.exit(2) }
const file = join(dir, sessionFileName(dir))
console.log('会话目录：' + dir)

let raw = null
// 2026-11-20 R2-H5：多帧日志统一走 zstd-safe（fzstd → CLI → 内置）
try { raw = unzstd(readFileSync(file)) } catch (e) { console.error('解压失败：' + (e?.message ?? e)); process.exit(2) }
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
if (typeof zstdCompressSync !== 'function') { console.error('当前 Node 不支持 zstd 压缩（需要 22.15+），无法安全重写会话；请升级 Node 或改用 DSH 面板的修复按钮'); process.exit(2) }
// 每行一帧，保持多帧格式（单帧重打包曾把会话弄丢，绝不再犯）
const outLines = kept.map((e) => JSON.stringify(e))
writeFileSync(file, Buffer.concat(outLines.map((l) => zstdCompressSync(Buffer.from(l + '\n')))))
console.log('已修复，原文件备份：' + bak)