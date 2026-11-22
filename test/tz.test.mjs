// 时区可配置回归：同一时刻在不同 timezone 下的日键/分钟数必须不同，非法值回默认
import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeZone, getTimeZone, normalizeTimeZone, isValidTimeZone, zoneDayKey, zoneMinutesOfDay, logicalDayKey, timeZoneHonored } from '../lib/tz.mjs'
import { dayKey, minutesOfDayBJ, decideDailyClean } from '../lib/offclean-day.mjs'

const T20 = Date.parse('2026-11-20T20:00:00Z') // 北京 11-21 04:00，UTC 11-20 20:00

test('非法时区回默认，合法 IANA 保留', () => {
  assert.equal(isValidTimeZone('Asia/Shanghia'), false)
  assert.equal(isValidTimeZone('Asia/Shanghai'), true)
  assert.equal(normalizeTimeZone('Not/AZone'), 'Asia/Shanghai')
  assert.equal(normalizeTimeZone(''), 'Asia/Shanghai')
  assert.equal(normalizeTimeZone('America/New_York'), 'America/New_York')
})

test('同一时刻：UTC 与上海日键相差一天', () => {
  setTimeZone('UTC')
  assert.equal(zoneDayKey(T20), '20261120')
  assert.equal(zoneMinutesOfDay(T20), 20 * 60)
  setTimeZone('Asia/Shanghai')
  assert.equal(zoneDayKey(T20), '20261121')
  assert.equal(zoneMinutesOfDay(T20), 4 * 60)
  assert.equal(dayKey(new Date(T20)), '2026-11-21')
})

test('作息日切点：04:00 归前一天，06:00 归当天', () => {
  setTimeZone('Asia/Shanghai')
  const t4 = Date.parse('2026-11-20T20:00:00Z') // 北京 04:00
  const t6 = Date.parse('2026-11-20T22:00:00Z') // 北京 06:00
  assert.equal(logicalDayKey(t4, 5), '20261120')
  assert.equal(logicalDayKey(t6, 5), '20261121')
})

test('每日清理的分钟数跟随配置时区', () => {
  setTimeZone('UTC')
  assert.equal(minutesOfDayBJ(new Date(T20)), 20 * 60)
  setTimeZone('Asia/Shanghai')
  assert.equal(minutesOfDayBJ(new Date(T20)), 4 * 60)
})

test('每日清理 04:30 按配置时区判定', () => {
  const cfg = { autoClean: true, cleanAtHour: 4, cleanAtMinute: 30 }
  setTimeZone('UTC')
  assert.equal(decideDailyClean({ now: new Date(Date.UTC(2026, 10, 21, 4, 30)), cfg, last: null }).ok, true)
  setTimeZone('Asia/Shanghai')
  assert.equal(decideDailyClean({ now: new Date(Date.UTC(2026, 10, 20, 20, 30)), cfg, last: null }).ok, true)
})

test('零偏移时区不被误判为 ICU 不支持', () => {
  assert.equal(timeZoneHonored('Africa/Abidjan'), true)
})

test('setTimeZone/getTimeZone 取当前值', () => {
  setTimeZone('UTC')
  assert.equal(getTimeZone(), 'UTC')
  setTimeZone('Asia/Shanghai')
  assert.equal(getTimeZone(), 'Asia/Shanghai')
})
