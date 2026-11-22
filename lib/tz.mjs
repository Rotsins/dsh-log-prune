// tz —— 全插件统一的时区口径（2026-11-21 管理员定：时区可配置）。
//
// 只做三件事：
//   1) 保存当前 IANA 时区（默认 Asia/Shanghai），配置存盘后热更新；
//   2) 按当前时区算「日键 YYYYMMDD」与「当天第几分钟」；
//   3) small-icu / 无 ICU 时回退 DSH_TZ_OFFSET（分钟），再不行按进程本地时区。
//
// 说明：Intl 的 timeZone 在 small-icu 构建里会被静默忽略（不抛错），
// 所以这里用「同一时刻在目标时区与 UTC 的格式化结果是否不同」来判定是否真的支持；
// UTC/零偏移时区两者本来就可能相同，直接放行（偏移 0 的兜底也是对的）。

export const DEFAULT_TZ = 'Asia/Shanghai'

let current = DEFAULT_TZ
const fmtCache = new Map()
const supportCache = new Map()

function offsetFallbackMin() {
  const raw = process.env.DSH_TZ_OFFSET
  const n = Number(raw)
  return raw !== undefined && raw !== '' && Number.isFinite(n) ? n : null
}

/** 是否是 Intl 认识的 IANA 时区（不抛错） */
export function isValidTimeZone(v) {
  const s = String(v == null ? '' : v).trim()
  if (!s) return false
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: s }).format(0)
    return true
  } catch {
    return false
  }
}

/** 合法 IANA 时区原样返回；空/非法回默认（不抛错） */
export function normalizeTimeZone(v) {
  const s = String(v == null ? '' : v).trim()
  return isValidTimeZone(s) ? s : DEFAULT_TZ
}

export function setTimeZone(v) {
  current = normalizeTimeZone(v)
  return current
}

export function getTimeZone() {
  return current
}

function fmt(tz, opts) {
  const key = tz + '|' + JSON.stringify(opts)
  let f = fmtCache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...opts })
    fmtCache.set(key, f)
  }
  return f
}

/** 该时区是否真的被 ICU 采纳（small-icu 会静默忽略） */
export function timeZoneHonored(tz = current) {
  if (supportCache.has(tz)) return supportCache.get(tz)
  let ok = false
  try {
    if (tz === 'UTC' || tz === 'Etc/UTC') ok = true
    else {
      const sample = (zone, ms) => fmt(zone, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).format(ms)
      const utc = (ms) => sample('UTC', ms)
      // 冬夏各取一个样本：伦敦这类「冬季等于 UTC」的时区靠夏季样本识别
      const differs = (zone) => sample(zone, Date.UTC(2020, 0, 15, 12)) !== utc(Date.UTC(2020, 0, 15, 12)) ||
        sample(zone, Date.UTC(2020, 6, 15, 12)) !== utc(Date.UTC(2020, 6, 15, 12))
      if (differs(tz)) ok = true
      else {
        // 与 UTC 相同有两种可能：该时区本身零偏移，或 small-icu 忽略了 timeZone。
        // 用已知 +8 的上海当试纸：它也相同 → ICU 坏了；它不同 → ICU 正常，零偏移时区可信。
        ok = differs('Asia/Shanghai')
      }
    }
  } catch { ok = false }
  supportCache.set(tz, ok)
  return ok
}

function dayByOffset(ms, offMin) {
  const d = new Date(Number(ms) + offMin * 60000)
  const p = (n) => String(n).padStart(2, '0')
  return String(d.getUTCFullYear()) + p(d.getUTCMonth() + 1) + p(d.getUTCDate())
}

/** 当前时区的日历日 YYYYMMDD */
export function zoneDayKey(ms = Date.now(), tz = current) {
  if (timeZoneHonored(tz)) {
    try { return fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(Number(ms)).replace(/-/g, '') } catch {}
  }
  const off = offsetFallbackMin()
  if (off !== null) return dayByOffset(ms, off)
  const d = new Date(Number(ms))
  const p = (n) => String(n).padStart(2, '0')
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate())
}

/** 当前时区的「当天第几分钟」0-1439 */
export function zoneMinutesOfDay(ms = Date.now(), tz = current) {
  if (timeZoneHonored(tz)) {
    try {
      const o = {}
      for (const p of fmt(tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(Number(ms))) o[p.type] = p.value
      return (Number(o.hour) % 24) * 60 + Number(o.minute)
    } catch {}
  }
  const off = offsetFallbackMin()
  const t = off !== null ? Number(ms) + off * 60000 : Number(ms)
  const d = new Date(t)
  return (off !== null ? d.getUTCHours() : d.getHours()) * 60 + (off !== null ? d.getUTCMinutes() : d.getMinutes())
}

/** 作息日：切点之前的小时归到前一天 */
export function logicalDayKey(ms = Date.now(), hour = 5, tz = current) {
  return zoneDayKey(Number(ms) - Number(hour) * 3600e3, tz)
}

/** 能力/诊断用：当前时区是否被采纳、走哪条兜底 */
export function timezoneState(tz = current) {
  const honored = timeZoneHonored(tz)
  const off = offsetFallbackMin()
  return {
    ok: honored,
    tz,
    mode: honored ? 'intl' : (off !== null ? 'offset' : 'local'),
    offsetMin: honored ? null : (off !== null ? off : null),
    fallback: honored ? '' : (off !== null ? 'DSH_TZ_OFFSET' : 'local'),
  }
}
