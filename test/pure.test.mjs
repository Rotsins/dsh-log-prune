// O14：纯函数单测（不进 npm 包，只在仓库里跑：npm test / node --test test/）
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePlate, buildTurns, pickBudgetSpans, replaySurfaceSpan, balancedUpTo,
  isPlaceholder, plateWindowDays, charLen, DAY_PLACEHOLDER, META_PLACEHOLDER, selectCutSpans,
  scanSummarySeq, decidePlateMerge, mergePlateChain,
} from '../lib/index.js'

const msg = (text) => ({ content: [{ type: 'text', text }] })

test('parsePlate 能从门牌读回日期/条数/区间', () => {
  const p = parsePlate(msg('[2026-01-02 全天记录已归档 · 7 条 · 原文 /a/b.Z 日志 · seq=12-40 · 翻原文：x]'))
  assert.equal(p.day, '20260102')
  assert.equal(p.count, 7)
  assert.equal(p.start, 12)
  assert.equal(p.end, 40)
  assert.equal(parsePlate(msg('普通消息')), null)
})

test('parsePlate 兼容旧格式门牌（结尾没有「翻原文/找内容」）', () => {
  const p = parsePlate(msg('[2026-11-17 全天记录已归档 · 696 条 · seq=80633-86610 · 摘要之前的记录已裁（只留摘要），原文见归档镜像或会话日志]'))
  assert.equal(p.day, '20261117')
  assert.equal(p.count, 696)
  assert.equal(p.start, 80633)
  assert.equal(p.end, 86610)
})

test('mergePlateChain 沿门牌链追到最早起点并累加条数', () => {
  const plates = [
    { seq: 106165, day: '20261118', count: 500, start: 103658, end: 106159 },
    { seq: 109472, day: '20261118', count: 586, start: 106165, end: 109466 },
    { seq: 112810, day: '20261118', count: 681, start: 109472, end: 112803 },
  ]
  const r = mergePlateChain(plates, 109472, 643)
  // 覆盖型（112810 的 681）+ 前驱链（586、500）全部累加，起点追到 103658
  assert.equal(r.start, 103658)
  assert.equal(r.count, 643 + 681 + 586 + 500)
  assert.equal(mergePlateChain([], 1000, 7).start, 1000)
  assert.equal(mergePlateChain([], 1000, 7).count, 7)
  // 断链（间隔过大）不并入
  const far = mergePlateChain([{ seq: 1, start: 10, end: 20, count: 5 }], 100000, 3)
  assert.equal(far.start, 100000)
  assert.equal(far.count, 3)
})

test('mergePlateChain 覆盖型门牌也并入起点/条数', () => {
  // B 覆盖 cutStart=80633，A 是 B 之前紧邻的前驱（end=80632）
  const plates = [
    { seq: 700, day: '20261116', count: 200, start: 78000, end: 80632 },
    { seq: 83195, day: '20261116', count: 483, start: 80633, end: 86610 },
  ]
  const r = mergePlateChain(plates, 80633, 693)
  assert.equal(r.start, 78000)
  assert.equal(r.count, 693 + 483 + 200)
})

test('scanSummarySeq 不把任务提示词和闲聊当摘要（2026-11-16 本地实测回归）', () => {
  const ev = (seq, type, text) => ({ seq, type, data: {}, derive: msg(text) })
  const events = [
    // 任务提示词：开头是「【裁切摘要任务】」，但第 1 条要求里含字面串「【裁切摘要】」
    ev(10, 'user/message', '【裁切摘要任务】为本会话写一份上下文摘要。\n要求：\n1. 文本第一行必须原样以「【裁切摘要】」开头；第二行写「覆盖：seq 16-3896」。'),
    // 闲聊里提到这几个字（正常讨论插件时会出现）
    ev(11, 'assistant/message', '我看了一下，这个【裁切摘要】的判定逻辑有问题，建议收紧。'),
    // 真摘要
    ev(12, 'assistant/message', '【裁切摘要】\n覆盖：seq 16-3896\n\n一、结论：链路已通。'),
  ]
  const session = {
    surface: { nodes: events.map((e) => e.seq) },
    eventAt: (s) => events.find((e) => e.seq === s),
    deriveEventMessage: (e) => e.derive,
  }
  assert.equal(scanSummarySeq(session), 12)
})

test('scanSummarySeq 逐块判：正文前有 reasoning 也能认出摘要（2026-11-16 本会话 seq 86676 回归）', () => {
  const blocks = (list) => ({ content: list })
  const events = [
    // 块0 是推理、块1 才是正文；拼起来判会漏
    {
      seq: 20, type: 'assistant/message',
      derive: blocks([
        { type: 'reasoning', text: '405937 ≥ 160000 → write summary. range 16-19' },
        { type: 'text', text: '【裁切摘要】\n覆盖：seq 16-19\n\n一、结论：通了。' },
      ]),
    },
    // 只在推理里讨论「覆盖：seq A-B」这个格式，不是摘要（seq 86910 回归）
    {
      seq: 21, type: 'assistant/message',
      derive: blocks([
        { type: 'reasoning', text: '摘要节点 seq 83245 写着「覆盖：seq 83022-83190」，所以……' },
        { type: 'text', text: '这个判定还有问题，我再看下。' },
      ]),
    },
  ]
  const session = {
    surface: { nodes: [20, 21] },
    eventAt: (s) => events.find((e) => e.seq === s),
    deriveEventMessage: (e) => e.derive,
  }
  assert.equal(scanSummarySeq(session), 20)
})

test('isPlaceholder 认工具结果/全天/跨天合并三种占位符', () => {
  assert.equal(isPlaceholder(msg('[某轮的工具结果已归档 · 3 条]')), true)
  assert.equal(isPlaceholder(msg(DAY_PLACEHOLDER('20260101', 5, '/a', 'sid', 1, 9))), true)
  assert.equal(isPlaceholder(msg(META_PLACEHOLDER(3, 20, 'sid'))), true)
  assert.equal(isPlaceholder(msg('今天天气不错')), false)
})

test('buildTurns 以 user 起头切轮，丢弃开头的非 user 节点', () => {
  const nodes = [
    { seq: 1, type: 'system/message', time: Date.UTC(2026, 0, 1) },
    { seq: 2, type: 'user/message', time: Date.UTC(2026, 0, 1) },
    { seq: 3, type: 'assistant/message', time: Date.UTC(2026, 0, 1) },
    { seq: 4, type: 'user/message', time: Date.UTC(2026, 0, 1) },
  ]
  const turns = buildTurns(nodes)
  assert.equal(turns.length, 2)
  assert.deepEqual(turns[0].seqs, [2, 3])
  assert.deepEqual(turns[1].seqs, [4])
})

test('pickBudgetSpans 到保留线就停，且跳过未归档/门牌', () => {
  const turns = [1, 2, 3, 4, 5].map((i) => ({ startSeq: i, endSeq: i, day: '2026010' + i, seqs: [i] }))
  const spans = pickBudgetSpans(turns, {
    tokens: 1000, keepTokens: 300, keepTurns: 1,
    archived: (s) => s !== 2,
    isPlate: (s) => s === 3,
    shadowOf: () => 200,
  })
  const kept = spans.flatMap((s) => s.seqs)
  assert.ok(!kept.includes(2), '未归档的轮不该被裁')
  assert.ok(!kept.includes(3), '门牌不该被裁')
  assert.ok(!kept.includes(5), '保留轮不该被裁')
})

test('pickBudgetSpans 在预算无限大时收齐所有可归档轮（摘要裁切用的模式）', () => {
  const turns = [1, 2, 3, 4].map((i) => ({ startSeq: i, endSeq: i, day: '20260101', seqs: [i] }))
  const spans = pickBudgetSpans(turns, {
    tokens: Number.MAX_SAFE_INTEGER, keepTokens: 0, keepTurns: 1,
    archived: () => true, isPlate: () => false, shadowOf: () => 1,
  })
  const kept = spans.flatMap((s) => s.seqs)
  assert.deepEqual(kept, [1, 2, 3], '除最后 keepTurns 轮外都要被收进可裁段')
})

test('selectCutSpans：同一天的多轮里，带摘要时切在摘要之前（复现 2026-11-16 那次"没有可裁段"）', () => {
  // 全部同一天，摘要位于第 3 轮（seq 5），后面还有两轮
  const turns = [
    { startSeq: 1, endSeq: 2, day: '20260101', seqs: [1, 2] },
    { startSeq: 3, endSeq: 4, day: '20260101', seqs: [3, 4] },
    { startSeq: 5, endSeq: 6, day: '20260101', seqs: [5, 6] }, // 摘要轮
    { startSeq: 7, endSeq: 8, day: '20260101', seqs: [7, 8] },
    { startSeq: 9, endSeq: 9, day: '20260101', seqs: [9] },
  ]
  const spans = selectCutSpans(turns, {
    summarySeq: 5, archived: () => true, isPlate: () => false, shadowOf: () => 100, keepTurns: 2,
  })
  const kept = spans.flatMap((s) => s.seqs)
  assert.deepEqual(kept, [1, 2, 3, 4], '只裁摘要之前的两轮，且不能在摘要处被整段丢掉')
  assert.ok(spans.every((s) => s.endSeq < 5))
})

test('selectCutSpans：没有摘要时仍按预算停手', () => {
  const turns = [1, 2, 3, 4, 5].map((i) => ({ startSeq: i, endSeq: i, day: '2026010' + i, seqs: [i] }))
  const spans = selectCutSpans(turns, {
    summarySeq: 0, tokens: 1000, keepTokens: 700, keepTurns: 1,
    archived: () => true, isPlate: () => false, shadowOf: () => 200,
  })
  const kept = spans.flatMap((s) => s.seqs)
  assert.ok(kept.length >= 1 && kept.length < 4, '预算到线就停，不该全收')
  assert.ok(!kept.includes(5), '最后 keepTurns 轮不裁')
})

test('replaySurfaceSpan 能重放替换后的表面，不自洽时返回 null', () => {
  const ev = new Map([
    [1, { type: 'user/message', surfaceOp: 'append' }],
    [2, { type: 'assistant/message', surfaceOp: 'append' }],
    [3, { type: 'user/message', surfaceOp: 'append' }],
    [4, { type: 'user/message', surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 } }],
  ])
  const eventAt = (s) => ev.get(s)
  // 1..2 被 4 替换掉了：再重放这两端不在表面里，必须返回 null（宁可不裁）
  assert.equal(replaySurfaceSpan(eventAt, 1, 2, 4), null)
  assert.deepEqual(replaySurfaceSpan(eventAt, 3, 3, 4), [3])
  assert.equal(replaySurfaceSpan(eventAt, 2, 3, 4), null)
})

test('balancedUpTo 数未闭合的工具调用', () => {
  const ev = new Map([
    [1, { type: 'tool/call' }],
    [2, { type: 'tool/result' }],
    [3, { type: 'tool/call' }],
  ])
  const session = { eventAt: (s) => ev.get(s) }
  assert.equal(balancedUpTo([1, 2], session, 2), true)
  assert.equal(balancedUpTo([1, 2, 3], session, 3), false)
})

test('plateWindowDays 夹在 2~7 天', () => {
  assert.equal(plateWindowDays(100000, 0), 7)
  assert.equal(plateWindowDays(100000, 100000), 2)
  assert.ok(plateWindowDays(300000, 100000) >= 2 && plateWindowDays(300000, 100000) <= 7)
})

test('charLen 按码点计数（汉字算 1）', () => {
  assert.equal(charLen(msg('你好abc')), 5)
  assert.equal(charLen({ content: [{ type: 'tool-call' }] }), 0)
})

test('decidePlateMerge 开关关闭时不合并', () => {
  const p = decidePlateMerge([100, 200, 300, 400, 500], 1, 4, 200, 500, () => false, () => false, () => false, false)
  assert.equal(p.mergePlate, false)
})

test('decidePlateMerge 门牌 seq 不早于终点时不合并', () => {
  const p = decidePlateMerge([100, 200, 300, 400, 500], 1, 4, 600, 500, () => false, () => false, () => false, true)
  assert.equal(p.mergePlate, false)
})

test('decidePlateMerge 合并时起点取门牌左边真实节点', () => {
  const p = decidePlateMerge([100, 200, 300, 400, 500], 1, 4, 200, 500, () => false, () => false, () => false, true)
  assert.equal(p.mergePlate, true)
  assert.equal(p.iA0, 0)
  assert.equal(p.skippedLead, 1)
})

test('decidePlateMerge 左边先遇摘要节点放弃合并', () => {
  const p = decidePlateMerge([10, 200, 300, 400, 500], 1, 4, 200, 500, () => true, () => true, () => false, true)
  assert.equal(p.mergePlate, false)
})

test('decidePlateMerge 左边是 system/message 放弃合并', () => {
  const p = decidePlateMerge([10, 200, 300, 400, 500], 1, 4, 200, 500, () => false, () => false, (s) => s === 10, true)
  assert.equal(p.mergePlate, false)
})
