#!/usr/bin/env node
// make-clean-test-archive.mjs —— 生成一个可清理的测试归档（含 data.stream）
// 用途：设备上没有真实可清内容时，验证「清理 → restart-request → watcher 重启」全链路。
// 验证后删除该测试归档（20991231_session-clean-test.日志*）即可，不影响真实会话。
import fs from 'node:fs'
import path from 'node:path'
import { ARCHIVE_DIR } from '../lib/archive.mjs'
import { compressZstd } from '../lib/zstd-safe.mjs'

const day = '20991231'
const sid = 'session-clean-test'
const file = path.join(ARCHIVE_DIR, day + '_' + sid + '.日志')
if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true })

const now = Date.now()
const evs = [
  { type: 'session', id: sid, time: now, seq: 0 },
  { type: 'assistant/message', seq: 1, time: now, data: { turn: 0, step: 0, message: { id: 'test-m1', role: 'assistant', content: [{ type: 'text', text: '清理测试消息一' }] }, stream: [{ type: 'chunk', text: '清理测试消息一' }] } },
  { type: 'assistant/message', seq: 2, time: now, data: { turn: 0, step: 1, message: { id: 'test-m2', role: 'assistant', content: [{ type: 'text', text: '清理测试消息二' }] }, stream: [{ type: 'chunk', text: '清理测试消息二' }] } },
]
const frames = evs.map((e) => compressZstd(Buffer.from(JSON.stringify(e) + '\n')))
const parts = []
const meta = []
let off = 0
for (let i = 0; i < frames.length; i++) {
  parts.push(frames[i])
  meta.push({ off, len: frames[i].length, from: evs[i].seq, to: evs[i].seq, n: 1, at: now })
  off += frames[i].length
}
fs.writeFileSync(file, Buffer.concat(parts))
fs.writeFileSync(file + '.frames.jsonl', meta.map((m) => JSON.stringify(m)).join('\n') + '\n')
fs.writeFileSync(file + '.seqs.json', JSON.stringify({ ranges: [[0, 2, 3]], complete: true, at: now }))
// 清理器会跳过 60 秒内写过的文件；把 mtime 设旧，保证测试样本立即可清
const old = new Date(Date.now() - 10 * 60e3)
fs.utimesSync(file, old, old)
console.log('已生成测试归档: ' + file)
console.log('下一步：面板「清理」dry 应显示 1 个归档含 stream；真清理后该文件被重写（stream 剥掉）并触发重启。')
