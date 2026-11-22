// 每日离线清理的「当天只派一次」判定与认领落盘。
//
// 2026-11-21 事故：原实现只用内存变量 cleanDay 记住「今天派过了」。
// offline-clean 的流程本身包含「停 DSH → 清理 → 拉起 DSH」，
// DSH 一重启，内存清空，cleanDay 回到 ''；而补跑窗口是 6 小时，
// 于是重启后的下一分钟又满足条件再派一次 —— 每 2 分钟一轮，无限重启。
//
// 现在改成两层「跨重启」的闸：
//   1) state/offclean-day-<YYYY-MM-DD>.claim：用 O_EXCL 创建，谁建到谁派发；
//      当天文件已存在就永远不再派（失败也不自动重试，等明天或手工点面板）。
//   2) prune-clean-last.json 只用来判「今天」；跨天一律不参考上一条记录，
//      否则昨天晚跑/补跑会把今天误判成「刚清过」而整天跳过。
import fs from 'node:fs'
import path from 'node:path'
import { writeJsonAtomic } from './atomic.mjs'
import { dayOf } from './daycut.mjs'
import { zoneMinutesOfDay } from './tz.mjs'

// 只容忍调度抖动（进程卡一下/定时器晚几十秒），不跨休眠补跑：
// 用户机器大多是笔记本，睡醒后突然「停 DSH → 清理 → 拉起」比漏跑一天更糟。
const CATCHUP_MIN = 5



// F10：「当天」按北京时间算，与归档/门牌口径一致，不再用宿主机本地时钟。
// 走 dayOf(t, 0)：不叠作息日偏移，取纯日历日；small-icu 下由 daycut 的手工偏移兜底。
export function dayKey(d = new Date()) {
  try {
    const raw = dayOf(d.getTime(), 0)
    if (/^\d{8}$/.test(raw)) return raw.slice(0, 4) + '-' + raw.slice(4, 6) + '-' + raw.slice(6, 8)
  } catch {}
  const p2 = (n) => (n < 10 ? '0' : '') + n
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
}

// 「配置时区的当天第几分钟」，与宿主机时区无关（默认 Asia/Shanghai）
export function minutesOfDayBJ(d = new Date()) {
  return zoneMinutesOfDay(d.getTime())
}

// 读上次派发记录；老格式没有 day 字段时用 at 反推，兼容事故前写下的文件
export function readLastClean(file) {
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!rec || typeof rec !== 'object') return null
    if (!rec.day && Number.isFinite(Number(rec.at))) rec.day = dayKey(new Date(Number(rec.at)))
    return rec
  } catch { return null }
}

export function writeLastClean(file, rec) {
  try { writeJsonAtomic(file, rec) } catch {}
}

// 纯判定：不读盘、不派发，方便单测。返回 { ok, reason, runId }
export function decideDailyClean({ now = new Date(), cfg = {}, last = null, unitActive = false, resumed = false } = {}) {
  if (!cfg.autoClean) return { ok: false, reason: 'autoClean 未开' }
  if (unitActive) return { ok: false, reason: '已有清理单元在跑' }
  const h = Number(cfg.cleanAtHour)
  const m = Number(cfg.cleanAtMinute)
  if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isInteger(m) || m < 0 || m > 59) {
    return { ok: false, reason: '清理时间配置非法（cleanAtHour/cleanAtMinute）' }
  }
  const day = dayKey(now)
  // 只看「今天」：认领文件保证一天最多一次。跨天绝不参考上一条记录——
  // 否则昨天晚跑（补跑/时钟跳变）会把今天误判成「刚清过」，甚至整天空过。
  if (last && last.day === day) {
    // F12：派发失败且标记为可重试时，隔一分钟允许再试；成功派发/永久失败一律当天不再动
    const retry = last.phase === 'failed' && Number(last.retryCount || 0) > 0
    if (!retry) return { ok: false, reason: '今天已派过（' + String(last.runId || '') + '）' }
    if (now.getTime() - Number(last.at || 0) < 60000) return { ok: false, reason: '派发失败，等待 1 分钟后重试' }
  }

  const nowMin = minutesOfDayBJ(now)
  const planMin = h * 60 + m
  if (nowMin < planMin) return { ok: false, reason: '还没到计划时间' }
  // 检测到休眠/时钟跳变（两分钟以上没走 tick）就整天不补：恢复后不打扰用户
  if (resumed) return { ok: false, reason: '检测到休眠或时钟跳变，今天不补跑' }
  if (nowMin - planMin > CATCHUP_MIN) return { ok: false, reason: '已过补跑窗口（最多 ' + CATCHUP_MIN + ' 分钟）' }
  return { ok: true, reason: '', runId: 'daily-' + day.replace(/-/g, '') }
}

// 当天认领：O_EXCL 创建成功才允许派发；返回 false 表示别的进程/上一轮已经认领
export function claimDay(stateDir, day) {
  const file = path.join(stateDir, 'offclean-day-' + day + '.claim')
  try {
    const fd = fs.openSync(file, 'wx')
    try { fs.writeSync(fd, JSON.stringify({ day, pid: process.pid, at: Date.now() })) } finally { fs.closeSync(fd) }
    return true
  } catch (e) {
    if (e && e.code === 'EEXIST') return false
    throw e
  }
}

export function dayClaimPath(stateDir, day) {
  return path.join(stateDir, 'offclean-day-' + day + '.claim')
}
