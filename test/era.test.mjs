// era.test.mjs —— O2 时代合并：残留扫描 / 触发判断 / 合并指令（纯函数，无 DSH 依赖）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanResidue, eraNeeded, eraInstruction } from '../lib/era.mjs'

// 造一个最小 session：surface.nodes 是 seq 列表，eventAt 按 seq 查事件
function fakeSession(events) {
  const map = new Map(events.map((e) => [e.seq, e]))
  const nodes = events.map((e) => e.seq)
  return {
    surface: { nodes },
    eventAt: (s) => map.get(s),
    deriveEventMessage: (ev) => ({ content: ev?.data?.content ?? [] }),
  }
}

const plate = (seq, start, end, count = 10) => ({
  seq, type: 'user/message',
  data: { content: [{ type: 'text', text: '[2026-11-01 全天记录已归档 · ' + count + ' 条 · 原文 归档 · seq=' + start + '-' + end + ' · 找内容：log_prune_search("k")；取全文：log_prune_read(' + start + ',' + end + ')]' }] },
})
const summary = (seq) => ({
  seq, type: 'assistant/message',
  data: { content: [{ type: 'text', text: '【裁切摘要】\n覆盖：seq 1-100\n……' }] },
})
const plain = (seq) => ({ seq, type: 'user/message', data: { content: [{ type: 'text', text: '普通消息 ' + seq }] } })
const sys = (seq) => ({ seq, type: 'system/message', data: { content: [{ type: 'text', text: 'system prompt' }] } })

test('scanResidue：门牌与旧摘要都被识别，system/普通消息不算残留', () => {
  const s = fakeSession([sys(0), plate(1, 1, 100), plain(2), summary(3), plain(4)])
  const r = scanResidue(s)
  assert.equal(r.plates.length, 1)
  assert.equal(r.summaries.length, 1)
  assert.equal(r.firstSeq, 1)
  assert.equal(r.lastSeq, 3)
})

test('eraNeeded：门牌达标或摘要达标即触发，未达标不触发', () => {
  const s = fakeSession([sys(0), plate(1, 1, 100), plate(2, 101, 200), plate(3, 201, 300), plate(4, 301, 400)])
  const r = scanResidue(s)
  assert.equal(eraNeeded(r, { eraMergePlates: 4, eraMergeSummaries: 2 }), true)
  const r2 = scanResidue(fakeSession([sys(0), plate(1, 1, 100), plate(2, 101, 200)]))
  assert.equal(eraNeeded(r2, { eraMergePlates: 4, eraMergeSummaries: 2 }), false)
  const r3 = scanResidue(fakeSession([sys(0), summary(1), summary(2)]))
  assert.equal(eraNeeded(r3, { eraMergePlates: 4, eraMergeSummaries: 2 }), true)
})

test('eraInstruction：带任务标记与覆盖行，且不要求门牌索引复述', () => {
  const t = eraInstruction({ from: 100, to: 900 })
  assert.ok(t.startsWith('【裁切摘要任务】'))
  assert.ok(t.includes('覆盖：seq 100-900'))
  assert.ok(!t.includes('门牌索引：')) // O4：合并模式不要求抄旧门牌
})

test('scanResidue：时间序上更晚的新摘要也算残留（等待被合并），数量随摘要增长', () => {
  const s = fakeSession([sys(0), summary(1), plain(2), summary(3), plain(4), summary(5)])
  const r = scanResidue(s)
  assert.equal(r.summaries.length, 3)
})
