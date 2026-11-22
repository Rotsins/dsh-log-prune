// idx-keep.test.mjs —— O1：.idx 与 .txt 保留期拆分（idxKeepDays: 0 = 永久）
// 说明：清理挂在「本次有新索引写入」的循环里（与 0.2.18 行为一致），且按 mtime 判过期——
// 当天文件会持续 append、mtime 一直刷新，所以测法是：先写一个老日期目录并把它做旧，
// 再写今天的新条目触发清理循环，断言老文件按各自保留期被删/被留。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeWriter } from '../lib/plain.mjs'

const OLD_DAY = '20260101'
const TODAY = '20261120'

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lp-idx-')) }

function entries(from, n) {
  const out = []
  for (let i = 0; i < n; i++) out.push({ seq: from + i, time: Date.now(), role: 'user', type: 'user/message', text: '测试内容 alpha ' + (from + i) })
  return out
}

function ageFiles(dir, days) {
  const past = (Date.now() - days * 86400000) / 1000
  for (const f of fs.readdirSync(dir)) {
    if (/^\d{8}\.(idx|txt)$/.test(f)) fs.utimesSync(path.join(dir, f), past, past)
  }
}

test('idxKeepDays: 0 → 老的 .txt 被清、.idx 永久保留，今天的新文件不受影响', () => {
  const root = tempDir()
  const write = makeWriter(root)
  write('s1', () => OLD_DAY, entries(1, 3), { keepDays: 30, idxKeepDays: 0, plainEnabled: true })
  const dir = path.join(root, 's1')
  assert.ok(fs.existsSync(path.join(dir, OLD_DAY + '.idx')))
  assert.ok(fs.existsSync(path.join(dir, OLD_DAY + '.txt')))
  ageFiles(dir, 40)
  // 写今天的新条目：触发清理循环（与生产一致：只有当轮有新索引写入时才顺手清理）
  write('s1', () => TODAY, entries(4, 3), { keepDays: 30, idxKeepDays: 0, plainEnabled: true })
  const files = fs.readdirSync(dir)
  assert.ok(!files.includes(OLD_DAY + '.txt'), '过期 .txt（40 天 > 30 天）应被清理')
  assert.ok(files.includes(OLD_DAY + '.idx'), '.idx 在 idxKeepDays=0 下应永久保留')
  assert.ok(files.includes(TODAY + '.idx') && files.includes(TODAY + '.txt'), '今天的新文件不受影响')
})

test('idxKeepDays: 2 → 过期 .idx 一并清理（旧行为可回退）', () => {
  const root = tempDir()
  const write = makeWriter(root)
  write('s2', () => OLD_DAY, entries(1, 3), { keepDays: 30, idxKeepDays: 2, plainEnabled: true })
  const dir = path.join(root, 's2')
  ageFiles(dir, 40)
  write('s2', () => TODAY, entries(4, 3), { keepDays: 30, idxKeepDays: 2, plainEnabled: true })
  const files = fs.readdirSync(dir)
  assert.ok(!files.includes(OLD_DAY + '.idx'), '.idx 超期（40 天 > 2 天）应被清理')
  assert.ok(!files.includes(OLD_DAY + '.txt'))
})

test('未传 idxKeepDays 的旧调用方：行为与 0.2.18 一致（.idx 跟 keepDays）', () => {
  const root = tempDir()
  const write = makeWriter(root)
  write('s3', () => OLD_DAY, entries(1, 3), { keepDays: 5, plainEnabled: true })
  const dir = path.join(root, 's3')
  ageFiles(dir, 40)
  write('s3', () => TODAY, entries(4, 3), { keepDays: 5, plainEnabled: true })
  const files = fs.readdirSync(dir)
  assert.ok(!files.includes(OLD_DAY + '.idx'))
  assert.ok(!files.includes(OLD_DAY + '.txt'))
})
