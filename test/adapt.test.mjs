// N 批验收单测（2026-11-19 1334 版复查报告）
import test from 'node:test'
import assert from 'node:assert/strict'
import { zstdCompressSync } from 'node:zlib'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sessionFileName } from '../lib/session-file.mjs'
import { readZstd, setZstd } from '../lib/archive.mjs'
import { decompress as vendorDecompress } from '../lib/vendor/fzstd.mjs'

test('N4: v4/v5 共存返回 v5，仅 v4 返回 v4', () => {
  const d = mkdtempSync(join(tmpdir(), 'sf-'))
  writeFileSync(join(d, 'session.v4.jsonl.zstd'), '')
  writeFileSync(join(d, 'session.v5.jsonl.zstd'), '')
  assert.equal(sessionFileName(d), 'session.v5.jsonl.zstd')
  rmSync(join(d, 'session.v5.jsonl.zstd'))
  assert.equal(sessionFileName(d), 'session.v4.jsonl.zstd')
  // S2：版本优先于压缩格式——v5 明文必须压过 v4 压缩（旧 offline 排序是反的）
  writeFileSync(join(d, 'session.v5.jsonl'), '')
  assert.equal(sessionFileName(d), 'session.v5.jsonl')
  rmSync(d, { recursive: true, force: true })
})

test('N2: 双帧 zstd 经 vendor 解出全部行（不退化首帧）', () => {
  const d = mkdtempSync(join(tmpdir(), 'rz-'))
  const f = join(d, 's.zstd')
  const f1 = zstdCompressSync(Buffer.from('{"a":1}\n{"a":2}\n'))
  const f2 = zstdCompressSync(Buffer.from('{"a":3}\n'))
  writeFileSync(f, Buffer.concat([f1, f2]))
  setZstd({ decompress: vendorDecompress, vendorPath: '' })
  const out = readZstd(f).toString('utf8').split('\n').filter(Boolean)
  assert.equal(out.length, 3)
  rmSync(d, { recursive: true, force: true })
})