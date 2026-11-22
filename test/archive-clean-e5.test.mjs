// E5 回归：帧侧车归档按帧流式清理，重写后帧偏移连续、内容只置空 stream
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { cleanArchiveStreams } from '../lib/archive-clean.mjs'

const hasZstd = typeof zlib.zstdCompressSync === 'function'
const H = (n) => zlib.zstdCompressSync(Buffer.from(n + '\n'))

function makeArchive(dir, name, { withStream }) {
  const evs = [
    { type: 'session', seq: -1, sid: 's1' },
    { type: 'message', seq: 1, data: { text: 'keep me' } },
    { type: 'assistant/message', seq: 2, data: { stream: withStream ? ['a', 'b'] : [] } },
    { type: 'message', seq: 3, data: { text: 'tail' } },
  ]
  const frames = [H(JSON.stringify(evs[0]))]
  frames.push(H(evs.slice(1, 3).map((e) => JSON.stringify(e)).join('\n')))
  frames.push(H(JSON.stringify(evs[3])))
  const buf = Buffer.concat(frames)
  const file = path.join(dir, name)
  fs.writeFileSync(file, buf)
  let off = 0
  const meta = frames.map((f, i) => {
    const m = { off, len: f.length, from: i === 0 ? -1 : (i === 1 ? 1 : 3), to: i === 0 ? -1 : (i === 1 ? 2 : 3), n: i === 0 ? 1 : (i === 1 ? 2 : 1), at: Date.now() }
    off += f.length
    return m
  })
  fs.writeFileSync(file + '.frames.jsonl', meta.map((m) => JSON.stringify(m)).join('\n') + '\n')
  fs.writeFileSync(file + '.seqs.json', JSON.stringify({ ranges: [[1, 3, 4]], complete: true, at: Date.now() }))
  // 避开 QUIET_MS
  const old = Date.now() / 1000 - 3600
  fs.utimesSync(file, old, old)
  return file
}

test('帧侧车归档：只置空 stream，帧偏移连续，其它事件保留', { skip: hasZstd ? false : '当前 Node 无 zstd' }, async () => {
  process.env.DSH_CLEAN_QUIET_MS = '0'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-e5-'))
  const file = makeArchive(dir, '20260101_s1.日志', { withStream: true })
  const r = await cleanArchiveStreams({ dry: false, dir, reconcile: false })
  assert.equal(r.ok, true)
  assert.equal(r.cleaned, 1)
  const meta = fs.readFileSync(file + '.frames.jsonl', 'utf8').trim().split('\n').map(JSON.parse)
  let pos = 0
  for (const m of meta) { assert.equal(m.off, pos); pos += m.len }
  assert.equal(pos, fs.statSync(file).size)
  const buf = fs.readFileSync(file)
  const lines = []
  for (const m of meta) lines.push(zlib.zstdDecompressSync(buf.subarray(m.off, m.off + m.len)).toString('utf8'))
  const evs = lines.join('').split('\n').filter(Boolean).map(JSON.parse)
  assert.equal(evs.length, 4)
  assert.equal(evs[1].data.text, 'keep me')
  // 归档侧是删除字段（不是置空数组）：归档只用于检索，不被 DSH 当会话加载
  assert.equal('stream' in evs[2].data, false)
  assert.equal(evs[3].data.text, 'tail')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('没有 stream 的归档不重写（mtime 不动）', { skip: hasZstd ? false : '当前 Node 无 zstd' }, async () => {
  process.env.DSH_CLEAN_QUIET_MS = '0'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-e5b-'))
  const file = makeArchive(dir, '20260102_s2.日志', { withStream: false })
  const before = fs.statSync(file).mtimeMs
  const r = await cleanArchiveStreams({ dry: false, dir, reconcile: false })
  assert.equal(r.cleaned, 0)
  assert.equal(fs.statSync(file).mtimeMs, before)
  fs.rmSync(dir, { recursive: true, force: true })
})
