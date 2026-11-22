// ensure-archive.mjs —— 裁切前的「原文已另存」硬检查（2026-11-18）
// 口径：必须已经落进 记忆/日志存档/<日期>_<sid>.日志，而不是「会话日志里还能读到」。
// 流程：先查水位 → 没覆盖就现场补一次归档（只处理本会话）→ 再查 → 仍不满足就不裁。
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveHome } from './home.mjs'

// O5（2026-11-18）：本文件原来自己拼 HOME（DSH_HOME || '/data/dsh'），在 ~/.dsh / Windows 桌面版
// 上会指向不存在的路径 → watermark 恒 -1 → 每次裁切都 spawn 一个不存在的脚本 → 裁切整体停摆。
// 统一走 resolveHome()（与 index.js / config.mjs / watcher.mjs / daycut.mjs 同一口径）。
const HOME = resolveHome()
const WM = process.env.DSH_ARCHIVE_WM || path.join(HOME, 'state', 'archive-watermark.json')
// 2026-11-19 Windows：脚本可在 DSH_HOME/bin，也可随插件带在 bin/（tgz 自带），按序找第一个存在的
const SCRIPT = (() => {
  // 显式配置优先且不回退：设了 DSH_ARCHIVE_SCRIPT 就用它，路径错就快速报错；
  // 以前会跳过不存在的显式值、回退到插件自带脚本，导致“想禁用/测试”变成真的跑一次补档。
  const explicit = process.env.DSH_ARCHIVE_SCRIPT
  if (explicit) return explicit
  const cands = [
    path.join(HOME, 'bin', 'archive-sessions.mjs'),
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'archive-sessions.mjs'),
  ]
  return cands.find((p) => fs.existsSync(p)) || cands[0]
})()

function watermark(sid) {
  try { return Number(JSON.parse(fs.readFileSync(WM, 'utf8'))[sid] ?? -1) } catch { return -1 }
}

const ARCHIVE_DIR = process.env.DSH_LOG_ARCHIVE || path.join(HOME, '记忆', '日志存档')

// 2026-11-19：水位只说明「归档脚本跑过」，不保证区间连续——1f37 出现过 wm=119186
// 而归档只到 117985。现在按归档文件里的 seqs.json ranges 核对整段是否连续。
function archiveRanges(sid) {
  let files = []
  try { files = fs.readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith(sid + '.日志')) } catch { return [] }
  const ranges = []
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, f + '.seqs.json'), 'utf8'))
      for (const r of j.ranges || []) if (Array.isArray(r) && r.length >= 2) ranges.push([Number(r[0]), Number(r[1])])
    } catch {}
  }
  ranges.sort((a, b) => a[0] - b[0])
  return ranges
}

function rangesCover(ranges, from, to) {
  let cur = from
  for (const [s, e] of ranges) {
    if (e < cur) continue
    if (s > cur) return false
    cur = e + 1
    if (cur > to) return true
  }
  return cur > to
}

// 只查水位：归档脚本是「写完文件之后才落水位」，水位满足说明脚本跑过；
// 再加一道区间核对，防止「水位到了、中间被裁掉的段没归档」。
export function archiveReady(sid, toSeq, fromSeq = 0) {
  const wm = watermark(sid)
  const want = Number(toSeq) || 0
  if (!(wm >= want)) return { ok: false, why: 'watermark ' + wm + ' < ' + want }
  const from = Math.max(0, Number(fromSeq) || 0)
  if (!rangesCover(archiveRanges(sid), from, want)) return { ok: false, why: '归档区间不连续（需要 ' + from + '-' + want + '）' }
  return { ok: true, why: 'wm=' + wm }
}

// 同一个进程里串行跑：archive 脚本会读改写 watermark.json，并发会互相覆盖
let queue = Promise.resolve()
function serial(fn) {
  const p = queue.then(fn, fn)
  queue = p.then(() => {}, () => {})
  return p
}

// 闸门失败冷却：pre-step 每个 step 都会进这里，失败后 5 分钟内不再重试、不再 spawn 子进程
// （原来失败只 writeStatus 然后 break，到线期间每个 step 都 spawn 一个最长 60 秒的子进程）
const COOL_MS = 5 * 60 * 1000
const cool = new Map() // sid -> until(ms)
const failCount = new Map() // sid -> 连续补不上次数（用于告警，不降级裁切）

export async function ensureArchived(sid, toSeq, opts = {}) {
  const now = Date.now()
  const until = cool.get(sid) || 0
  if (now < until) return { ok: false, ran: false, why: '闸门冷却中（' + Math.ceil((until - now) / 1000) + 's）' }
  const first = archiveReady(sid, toSeq, opts.fromSeq)
  if (first.ok) return { ...first, ran: false }
  const res = await serial(async () => {
  const again = archiveReady(sid, toSeq, opts.fromSeq)
  if (again.ok) return { ...again, ran: false }
  await new Promise((resolve) => {
    // 2026-11-19 Windows：桌面端 execPath 是 Electron，需 ELECTRON_RUN_AS_NODE；可用 DSH_NODE 指到 node.exe
    execFile(process.env.DSH_NODE || process.execPath, [SCRIPT, '--sid', sid, ...(opts.fromSeq != null ? ['--from', String(Number(opts.fromSeq) || 0), '--to', String(Number(toSeq) || 0)] : [])], { timeout: opts.timeoutMs || 60000, maxBuffer: 1 << 20, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
      (err, stdout, stderr) => {
        if (err) opts.log?.('补归档失败 ' + String(sid).slice(0, 16) + '：' + (err.message || stderr || '').slice(0, 200))
        resolve()
      })
  })
  const second = archiveReady(sid, toSeq, opts.fromSeq)
  return { ...second, ran: true }
  })
  if (!res.ok) {
    cool.set(sid, Date.now() + COOL_MS)
    // B 兜底（2026-11-19）：不自动裁半截（会丢原文），但连续 3 次补不上要明确告警，不能无声卡死
    const n = (failCount.get(sid) || 0) + 1
    failCount.set(sid, n)
    if (n >= 3) opts.log?.('⚠ 归档缺口连续 ' + n + ' 次补不上，裁切阻塞（' + res.why + '）；用 dsh-fix 检查/补档')
  } else {
    failCount.delete(sid)
  }
  return res
}
