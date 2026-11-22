// 2026-11-21 回归：每日清理跨重启只能派一次（事故：重启后内存清空，补跑窗口内每 2 分钟重派）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decideDailyClean, dayKey, claimDay, readLastClean } from '../lib/offclean-day.mjs'

const at = (h, m, day = 21) => new Date(2026, 10, day, h, m, 0)
const cfg = (over = {}) => ({ autoClean: true, cleanAtHour: 4, cleanAtMinute: 30, ...over })

test('同一天已经派过 → 跳过（事故场景：重启后仍必须是 skip）', () => {
  const last = { day: '2026-11-21', at: at(4, 34).getTime(), kind: 'offline', runId: 'daily-20261121-0434' }
  const r = decideDailyClean({ now: at(4, 36), cfg: cfg(), last })
  assert.equal(r.ok, false)
  assert.match(r.reason, /今天已派过/)
})

test('同日、但记录是旧的分钟 runId 也认（兼容事故前的文件）', () => {
  const last = { at: at(8, 29).getTime(), kind: 'offline', runId: 'daily-20261121-0829' }
  assert.equal(readLastClean.length, 1)
  const r = decideDailyClean({ now: at(9, 0), cfg: cfg(), last: { ...last, day: dayKey(new Date(last.at)) } })
  assert.equal(r.ok, false)
})

test('跨天不受上一条记录影响：昨天 20:00 跑过，今天 04:30 照样派', () => {
  const last = { day: '2026-11-20', at: at(20, 0, 20).getTime(), kind: 'offline', runId: 'x' }
  const r = decideDailyClean({ now: at(4, 30, 21), cfg: cfg(), last })
  assert.equal(r.ok, true)
  assert.equal(r.runId, 'daily-20261121')
})

test('昨天最后一分钟跑过，今天也不能被误判：04:30 允许', () => {
  const last = { day: '2026-11-20', at: at(23, 59, 20).getTime(), kind: 'offline', runId: 'x' }
  const r = decideDailyClean({ now: at(4, 30, 21), cfg: cfg(), last })
  assert.equal(r.ok, true)
})

test('今天的认领文件只在今天生效：次日 claim 不被占用', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-claim-day-'))
  assert.equal(claimDay(dir, '2026-11-21'), true)
  assert.equal(claimDay(dir, '2026-11-22'), true) // 次日新文件，不继承昨天的认领
  fs.rmSync(dir, { recursive: true, force: true })
})

test('计划时间前 / 只容忍 5 分钟抖动 → 跳过', () => {
  assert.equal(decideDailyClean({ now: at(4, 29), cfg: cfg(), last: null }).ok, false)
  assert.equal(decideDailyClean({ now: at(4, 34), cfg: cfg(), last: null }).ok, true)
  assert.equal(decideDailyClean({ now: at(4, 36), cfg: cfg(), last: null }).ok, false)
  assert.equal(decideDailyClean({ now: at(10, 29), cfg: cfg(), last: null }).ok, false)
})

test('休眠/时钟跳变恢复后不补跑', () => {
  const r = decideDailyClean({ now: at(4, 31), cfg: cfg(), last: null, resumed: true })
  assert.equal(r.ok, false)
  assert.match(r.reason, /休眠|时钟/)
})

test('autoClean 关闭 / 已有单元在跑 / 时间配置非法 → 跳过', () => {
  assert.equal(decideDailyClean({ now: at(5, 0), cfg: cfg({ autoClean: false }), last: null }).ok, false)
  assert.equal(decideDailyClean({ now: at(5, 0), cfg: cfg(), last: null, unitActive: true }).ok, false)
  assert.equal(decideDailyClean({ now: at(5, 0), cfg: cfg({ cleanAtHour: 99 }), last: null }).ok, false)
})

test('F10 北京时间口径：UTC 20:31 = 北京 04:31，按 04:30 计划应放行', () => {
  const now = new Date(Date.UTC(2026, 10, 20, 20, 31)) // 北京 2026-11-21 04:31
  assert.equal(dayKey(now), '2026-11-21')
  const r = decideDailyClean({ now, cfg: cfg(), last: null })
  assert.equal(r.ok, true)
  assert.equal(r.runId, 'daily-20261121')
  // 北京 04:29 还不到点（UTC 20:29 前一天）
  assert.equal(decideDailyClean({ now: new Date(Date.UTC(2026, 10, 20, 20, 29)), cfg: cfg(), last: null }).ok, false)
})

test('事故复现路径：04:30 派发后 DSH 重启，之后每分钟都不再派', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-loop-'))
  const day = '2026-11-21'
  // 04:30 那一刻：认领 + 派发，落盘记录
  assert.equal(claimDay(dir, day), true)
  const last = { day, at: at(4, 30).getTime(), kind: 'offline', runId: 'daily-20261121' }
  // 模拟 04:31 重启后的新进程：内存是空的，只有磁盘上的 claim / last
  for (let m = 31; m <= 60 * 5; m++) {
    const now = new Date(2026, 10, 21, 4, m, 0)
    const r = decideDailyClean({ now, cfg: cfg(), last })
    assert.equal(r.ok, false, '第 ' + m + ' 分钟不应再派发')
  }
  // 就算 last 记录丢了，当天认领文件还在：调用方 claimDay() 拿到 false，同样不会派
  assert.equal(claimDay(dir, day), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('当天认领：只有第一次成功，跨进程也不会重复', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-claim-'))
  assert.equal(claimDay(dir, '2026-11-21'), true)
  assert.equal(claimDay(dir, '2026-11-21'), false)
  assert.equal(claimDay(dir, '2026-11-22'), true)
  fs.rmSync(dir, { recursive: true, force: true })
})
