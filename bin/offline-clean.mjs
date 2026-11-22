#!/usr/bin/env node
// offline-clean.mjs —— 离线深度清理编排（脱离 DSH 独立运行）
// 流程：预检 → 关闭 DSH → 等待退出 → 扫描会话 → 侧车(归档+水位) → 清理会话 data stream(置空数组)
//       → 清理归档内残留 stream → 全量校验 → 拉起 DSH → 收尾。全程写 run.log / status.json / report.json。
// 设计文档：清理模块-离线深度清理-方案与源码-20261120.md（2026-11-20）
//
// 用法（一般由插件面板派发，也可手工运行）：
//   node offline-clean.mjs --run-id <id> [--home <DSH_HOME>] [--pid <DSH主进程pid>] [--exe <DSH可执行文件>]
//        [--electron] [--dry-run] [--skip-archive-clean] [--restart-mode auto|none]
//        [--grace-ms 8000] [--settle-ms 1500]
//   --pid 不传 = 按「DSH 已关闭」处理（手工离线模式）；--dry-run 只扫描出报告，不关机、不写任何文件。
//   --electron 由派发方传入（DSH 桌面端 = Electron 壳），用于拉起阶段判断能否直接 start exe。
// 退出码：0 成功；2 预检失败；3 清理失败（已回滚）；4 拉起失败；5 参数/环境错误。
//
// 硬性安全约定（与插件既有语义一致）：
//   1) 先另存后清理：某会话侧车没成功 → 该会话绝不清理 stream（防真实信息丢失）。
//   2) 会话文件里 assistant/message.data.stream 一律置空数组 []，绝不 delete（DSH 0.2.2 seed 校验要求它是数组）。
//   3) 逐事件帧重写（每帧一行 JSON + \n），单帧会让 DSH 重启后读不到会话。
//   4) 所有写回先备份、tmp+rename 原子落盘；校验不过 → 全量回滚 → 仍拉起 DSH。
//   5) 关机前布置「死亡保险丝」：脚本中途崩溃也能在 N 分钟后自动把 DSH 拉起来。

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import os from 'node:os'
import { writeJsonAtomic } from '../lib/atomic.mjs'
import { execFileSync, spawn } from 'node:child_process'
import { detectSystemdUnit, systemctlArgs } from '../lib/procctl.mjs'
import { sessionFileName } from '../lib/session-file.mjs'
import { unzstd as safeUnzstd, compressZstd as safeCompress } from '../lib/zstd-safe.mjs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolveHome } from '../lib/home.mjs'
import { frameTexts } from '../lib/frame-pack.mjs'

// ────────────────────────── 参数 ──────────────────────────
const USAGE = [
  '用法：node offline-clean.mjs --run-id <id> [--home <DSH_HOME>] [--pid <pid>] [--exe <exe>]',
  '       [--electron] [--dry-run] [--skip-archive-clean] [--restart-mode auto|none]',
  '       [--grace-ms 8000] [--settle-ms 1500]',
  '',
  '手工运行：默认只允许 --dry-run 预检；确认要真清理必须再加 --apply。',
  '--help 显示本说明；未知参数会直接退出（exit 5），不会执行清理。',
].join(String.fromCharCode(10))
const argv = process.argv.slice(2)
const BOOL_ARGS = new Set(['--electron', '--dry-run', '--skip-archive-clean', '--help', '-h', '--apply'])
const VAL_ARGS = new Set(['--run-id', '--home', '--pid', '--exe', '--restart-mode', '--grace-ms', '--settle-ms'])
if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); process.exit(0) }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (BOOL_ARGS.has(a)) continue
  if (VAL_ARGS.has(a)) {
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) { console.error('参数 ' + a + ' 缺少值' + String.fromCharCode(10, 10) + USAGE); process.exit(5) }
    i++
    continue
  }
  console.error('未知参数：' + a + String.fromCharCode(10, 10) + USAGE)
  process.exit(5)
}
const argOf = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null }
const stamp = () => new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
const A = {
  runId: argOf('--run-id') || ('manual-' + stamp()),
  home: argOf('--home') || '',
  pid: argOf('--pid') != null ? Number(argOf('--pid')) : null,
  exe: argOf('--exe') || process.env.DSH_EXE || '',
  electron: process.argv.includes('--electron'),
  dryRun: process.argv.includes('--dry-run'),
  skipArchiveClean: process.argv.includes('--skip-archive-clean'),
  restartNone: (argOf('--restart-mode') || 'auto') === 'none',
  graceMs: Number(argOf('--grace-ms')) || 8000,
  settleMs: Number(argOf('--settle-ms')) || 1500,
}
if (!/^[\w.\-]+$/.test(A.runId)) { console.error('run-id 只允许字母数字.-_'); process.exit(5) }
if (!Number.isFinite(A.pid)) A.pid = null
// 手工运行护栏：插件派发一定带 --run-id；没有它又没有 --dry-run 时，必须显式 --apply
if (!A.dryRun && !argv.includes('--run-id') && !argv.includes('--apply')) {
  console.error('手工运行默认只允许预检。请加 --dry-run 预演；确认要真清理再加 --apply。' + String.fromCharCode(10, 10) + USAGE)
  process.exit(5)
}

// ────────────────────────── HOME / 路径 ──────────────────────────
// 与 bin/archive-sessions.mjs 同款探测：--home → DSH_HOME → C:\data\dsh → ~/.dsh
// B7：--home 优先，其余与插件/工具箱共用 resolveHome，避免三套探测各走各的
const HOME = A.home && fs.existsSync(A.home) ? path.resolve(A.home) : resolveHome()
const SESS = process.env.DSH_SESSIONS_ROOT || path.join(HOME, 'sessions')
const ARCHIVE_DIR = process.env.DSH_LOG_ARCHIVE || path.join(HOME, '记忆', '日志存档')
const STATE = path.join(HOME, 'state')
const WM_FILE = process.env.DSH_ARCHIVE_WM || path.join(STATE, 'archive-watermark.json')
const RUNS_DIR = path.join(STATE, 'offclean-runs')
const RUN_DIR = path.join(RUNS_DIR, A.runId)
// O4：每次完成一个会话就落 checkpoint；带同一个 --run-id 重跑时从断点继续，
// 不重复扫描/归档/备份。dry-run 不写 checkpoint。
const CKPT_FILE = path.join(RUN_DIR, 'checkpoint.json')
let ckpt = null
function saveCheckpoint() {
  if (!ckpt || A.dryRun) return
  try {
    ckpt.updatedAt = Date.now()
    ckpt.manifest = manifest
    const tmp = CKPT_FILE + '.tmp-' + process.pid
    fs.writeFileSync(tmp, JSON.stringify(ckpt))
    fs.renameSync(tmp, CKPT_FILE)
  } catch {}
}
const LOCK_FILE = path.join(STATE, 'offclean-lock.json')
const RUN_LOG = path.join(RUN_DIR, 'run.log')
const BRIEF_FILE = path.join(RUN_DIR, 'brief.txt')
const STATUS_FILE = path.join(RUN_DIR, 'status.json')
const REPORT_FILE = path.join(RUN_DIR, 'report.json')
const MANIFEST_FILE = path.join(RUN_DIR, 'manifest.json')

// ────────────────────────── 小工具 ──────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
import { tsLocal as fmtTsLocal } from '../lib/util.mjs'
const pad = (n, l = 2) => String(n).padStart(l, '0')
const tsLocal = (d = new Date()) => fmtTsLocal(d, true)
const fmtBytes = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : n >= 1024 ? (n / 1024).toFixed(1) + 'KB' : n + 'B'
const logBuf = []
function log(tag, msg) {
  const line = '[' + tsLocal() + '] [' + tag + '] ' + msg
  logBuf.push(line)
  try { fs.mkdirSync(RUN_DIR, { recursive: true }); fs.appendFileSync(RUN_LOG, line + '\n') } catch {}
  try { if (process.stdout.isTTY) console.log(line) } catch {}
}
const errOf = (e) => String((e && (e.message ?? e)) || e).slice(0, 200)
// 日志首行简报：结束时把「用时/会话/归档/stream」汇总插到 run.log 最前面
const START_MS = Date.now()
function fmtDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  return Math.floor(total / 60) + '分' + (total % 60) + '秒'
}
function writeBrief() {
  try {
    const d = new Date()
    const when = pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    const brief = '简报：' + when + ' 本次清理用时' + fmtDuration(Date.now() - START_MS) +
      '  共清理' + counts.sessionsCleaned + '个会话 ' + counts.archivesCleaned + '个归档文件 共计' + counts.streamEventsCleaned + '个data stream' +
      (A.dryRun ? '（预检，未修改）' : '') +
      (okFlag === false ? '（失败）' : '')
    // E7：简报单独存 brief.txt，不再「读全文→插一行→整体重写」run.log
    fs.writeFileSync(BRIEF_FILE, brief + '\n')
  } catch {}
}

// 阶段状态机：写 status.json（面板轮询它）
const counts = {
  sessionsScanned: 0, streamEventsCleaned: 0, sessionsCleaned: 0, sessionsSkipped: 0,
  bytesBefore: 0, bytesAfter: 0, archivedSessions: 0, archivedEvents: 0, archivedBytes: 0,
  holesFilled: 0, archivesCleaned: 0, archiveFramesCleaned: 0, plainIndexed: 0, errors: 0,
}
let curPhase = 'P0', curLabel = '预检', okFlag = null, lastMsg = ''
function setStatus(phase, label, msg) {
  if (phase) { curPhase = phase; curLabel = label }
  if (msg !== undefined) lastMsg = String(msg)
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true })
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      runId: A.runId, dry: A.dryRun, pid: process.pid, platform: process.platform, node: process.version,
      electron: A.electron, phase: curPhase, label: curLabel, ok: okFlag, updatedAt: Date.now(),
      counts, lastMsg,
    }))
  } catch {}
  // 锁文件心跳同步刷新（面板/派发路由用它判断任务是否还活着）
  try { fs.writeFileSync(LOCK_FILE, JSON.stringify({ runId: A.runId, pid: process.pid, updatedAt: Date.now() })) } catch {}
}
const fail = (msg) => { counts.errors++; log('错误', msg); setStatus(null, null, msg) }

// ────────────────────────── zstd 能力（三路兜底）──────────────────────────
let fzstdDecompress = null
const here = path.dirname(fileURLToPath(import.meta.url))
const fzstdCands = [process.env.DSH_FZSTD_MODULE,
  path.join(here, '..', 'lib', 'vendor', 'fzstd.mjs'),
  path.join(HOME, 'plugins', 'dsh-log-prune', 'lib', 'vendor', 'fzstd.mjs')].filter(Boolean)
for (const c of fzstdCands) {
  try { const m = await import(pathToFileURL(c).href); if (typeof m.decompress === 'function') { fzstdDecompress = m.decompress; break } } catch {}
}
const MAX_DECOMP = Math.max(1, Number(process.env.DSH_ARCHIVE_MAX_TEXT_MB) || 512) * 1024 * 1024
const hasZstdSync = typeof zlib.zstdCompressSync === 'function'
let zstdCliOk = null
function zstdCliAvail() {
  if (zstdCliOk !== null) return zstdCliOk
  try { execFileSync('zstd', ['--version'], { stdio: 'ignore', windowsHide: true }); zstdCliOk = true } catch { zstdCliOk = false }
  return zstdCliOk
}
function compressZstd(buf) { return safeCompress(buf) }
// 解压顺序与插件一致：fzstd(多帧全解) → zstd CLI → zlib(只有第一帧，最后兜底)
// S1：统一走 zstd-safe（多帧 fzstd → CLI → 内置，带大小上限）
function decompressBuf(buf) { return safeUnzstd(buf) }

// ────────────────────────── 明文检索索引（可选，与插件 plain.mjs 对接）──────────────────────────
let plainWriter = null
try {
  const plainCands = [process.env.DSH_PLAIN_MODULE, path.join(HOME, 'plugins', 'dsh-log-prune', 'lib', 'plain.mjs')].filter(Boolean)
  for (const c of plainCands) {
    try { const m = await import(pathToFileURL(c).href); if (typeof m.makeWriter === 'function') { plainWriter = m.makeWriter(process.env.DSH_LOG_PRUNE_INDEXDIR || path.join(STATE, 'prune-index')); break } } catch {}
  }
} catch {}

// 检索层按会话取配置：离线补档也必须遵守面板「保存到当前会话」的 plain* 设置。
// 读不到配置就跳过明文索引（绝不回落 30天/90天默认值去误写或误删）。
let 会话检索配置 = null
try {
  const cfgPath = process.env.DSH_LOG_PRUNE_CONFIG || path.join(STATE, 'log-prune.yml')
  if (!fs.existsSync(cfgPath)) throw new Error('找不到 ' + cfgPath)
  process.env.DSH_LOG_PRUNE_CONFIG = cfgPath
  process.env.DSH_LOG_PRUNE_SESSIONS = process.env.DSH_LOG_PRUNE_SESSIONS || path.join(STATE, 'log-prune-sessions.json')
  const m = await import(new URL('../lib/config.mjs', import.meta.url).href)
  if (typeof m.effectiveConfig !== 'function') throw new Error('config.mjs 没有导出 effectiveConfig')
  会话检索配置 = m.effectiveConfig
  log('P4/侧车', '检索配置按会话加载：' + cfgPath)
} catch (e) {
  log('P4/侧车', '检索配置不可用，明文索引将跳过（不按默认值误写/误删）：' + errOf(e))
}
const textOf = (e) => {
  const c = e?.data?.content ?? e?.data?.message?.content ?? e?.data?.text
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter((b) => b && typeof b.text === 'string').map((b) => b.text).join('\n')
  return ''
}
// 与 bin/archive-sessions.mjs 完全一致的按天切片口径（时区由 DSH_TZ 继承，默认 Asia/Shanghai，sv-SE 日期）
const TZ = (() => { const s = process.env.DSH_TZ || 'Asia/Shanghai'; try { new Intl.DateTimeFormat('en-CA', { timeZone: s }).format(0); return s } catch { return 'Asia/Shanghai' } })();
const dayOf = (t) => new Date(t).toLocaleDateString('sv-SE', { timeZone: TZ }).replaceAll('-', '')

// ────────────────────────── 会话/归档读写 ──────────────────────────
// S2：文件名适配统一走 lib/session-file.mjs（版本优先、同版本 zstd 优先），
// 不再保留「zstd 优先于更高版本」的另一套排序。
function listSessions() {
  const out = []
  for (const ws of fs.readdirSync(SESS)) {
    const wsDir = path.join(SESS, ws)
    let st; try { st = fs.statSync(wsDir) } catch { continue }
    if (!st.isDirectory() || ws.startsWith('.')) continue
    for (const sid of fs.readdirSync(wsDir)) {
      const dir = path.join(wsDir, sid)
      let st2; try { st2 = fs.statSync(dir) } catch { continue }
      if (!st2.isDirectory() || sid.startsWith('.')) continue
      const f = path.join(dir, sessionFileName(dir))
      if (fs.existsSync(f)) out.push({ ws, dirId: sid, file: f })
    }
  }
  return out
}
// 解析会话文件 → 逐行 {raw, obj}（坏行保留原文，绝不丢弃）
function readSessionText(file) {
  const buf = fs.readFileSync(file)
  return file.endsWith('.zstd') ? decompressBuf(buf).toString('utf8') : buf.toString('utf8')
}
function parseSessionFile(file) {
  const text = readSessionText(file)
  const items = []
  let head = null, bad = 0, streamEvents = 0
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    let obj = null
    try { obj = JSON.parse(raw) } catch { bad++ }
    if (obj && obj.type === 'session' && !head) head = obj
    if (obj && obj.type === 'assistant/message' && obj.data) {
      if (!Array.isArray(obj.data.stream) || obj.data.stream.length) streamEvents++
    }
    items.push({ raw, obj })
  }
  return { size: fs.statSync(file).size, items, head, bad, streamEvents, sid: (head && head.id) || '' }
}
// 归档侧挂文件读取
function readFramesIdx(file) {
  const out = []
  try {
    for (const line of fs.readFileSync(file + '.frames.jsonl', 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { const j = JSON.parse(line); if (Array.isArray([j.off, j.len])) out.push(j) } catch {}
    }
  } catch {}
  return out
}
// B4：单个归档区间的上限。正常会话 seq 十几万；超过 100 万的区间视为脏数据，
// 不再逐 seq 展开（否则一个 [0,1e9] 就能把扫描阶段卡死）。
const MAX_RANGE_SPAN = 1000000
function readSeqs(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file + '.seqs.json', 'utf8'))
    const ranges = (j.ranges || [])
      .filter((r) => Array.isArray(r) && r.length >= 2)
      .map((r) => [Number(r[0]), Number(r[1])])
      .filter(([a, b]) => Number.isSafeInteger(a) && Number.isSafeInteger(b) && a >= 0 && b >= a)
    return { ranges, complete: j.complete === true }
  } catch { return { ranges: [], complete: false } }
}
function archiveFilesOf(sid) {
  const out = []
  try { for (const f of fs.readdirSync(ARCHIVE_DIR)) if (f.endsWith('_' + sid + '.日志') && !f.includes('.bak-')) out.push(path.join(ARCHIVE_DIR, f)) } catch {}
  return out
}
function coveredOf(sid) {
  const covered = new Set()
  let coveredMax = -1
  for (const f of archiveFilesOf(sid)) {
    for (const [a, b] of readSeqs(f).ranges) {
      if (b - a > MAX_RANGE_SPAN) { log('P3', '忽略异常归档区间 ' + a + '-' + b + '（' + path.basename(f) + '）'); continue }
      for (let x = a; x <= b; x++) covered.add(x)
      if (b > coveredMax) coveredMax = b
    }
  }
  return { covered, coveredMax }
}
function mergeRanges(list) {
  const rs = list.map((r) => [Number(r[0]), Number(r[1]), Number(r[2] ?? (r[1] - r[0] + 1))]).filter((r) => Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] >= r[0])
  rs.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const r of rs) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1] + 1) { last[1] = Math.max(last[1], r[1]); last[2] += r[2] }
    else merged.push([r[0], r[1], r[2]])
  }
  return merged
}
// seqs.json 的 complete 诚实化：frames.jsonl 字节和 === 归档文件大小 才算 complete（O10 口径）
function computeComplete(dest) {
  try {
    let flen = 0
    for (const line of fs.readFileSync(dest + '.frames.jsonl', 'utf8').split('\n')) {
      if (!line) continue
      try { flen += JSON.parse(line).len || 0 } catch {}
    }
    return flen === fs.statSync(dest).size
  } catch { return false }
}
// 备份：会话沿用 .bak-stream-*（与既有恢复工具兼容），其余 .bak-offclean-*
let manifest = []
try { manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')) } catch {}
function saveManifest() { try { fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest)) } catch {} }
function backup(file, kind) {
  const ts = stamp()
  const suffix = kind === 'session' ? '.bak-stream-' + ts : '.bak-offclean-' + ts
  const bak = file + suffix
  fs.copyFileSync(file, bak)
  manifest.push({ orig: file, bak })
  saveManifest()
  pruneBaks(file)
  log('备份', path.relative(HOME, file) + ' → ' + path.basename(bak) + '（' + fmtBytes(fs.statSync(file).size) + '）')
  return bak
}
// B16：同一文件的历史备份轮转，保留最近 3 份；本次 manifest 里的（回滚要用）一律不动
function pruneBaks(file, keep = 3) {
  try {
    const dir = path.dirname(file), base = path.basename(file)
    const keepSet = new Set(manifest.map((m) => m.bak))
    const olds = []
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(base + '.bak-')) continue
      const p = path.join(dir, f)
      if (keepSet.has(p)) continue
      try { olds.push({ p, at: fs.statSync(p).mtimeMs }) } catch {}
    }
    if (olds.length <= keep) return
    olds.sort((a, b) => b.at - a.at)
    for (const x of olds.slice(keep)) { try { fs.unlinkSync(x.p) } catch {} }
  } catch {}
}
async function rollback(reason) {
  log('回滚', '开始全量回滚（' + reason + '），共 ' + manifest.length + ' 条记录')
  let n = 0
  for (const m of manifest) {
    try {
      if (m.created) { fs.rmSync(m.orig, { force: true }); try { fs.rmSync(m.orig + '.frames.jsonl', { force: true }) } catch {}; try { fs.rmSync(m.orig + '.seqs.json', { force: true }) } catch {}; log('回滚', '已删除本次新建 ' + path.relative(HOME, m.orig)); n++; continue }
      fs.copyFileSync(m.bak, m.orig)
      n++
      log('回滚', '已还原 ' + path.relative(HOME, m.orig))
    } catch (e) { log('回滚', '还原失败 ' + m.orig + '：' + errOf(e)) }
  }
  log('回滚', '回滚完成：' + n + '/' + manifest.length)
  return n
}
function cleanTmpLeftovers(dir) {
  try {
    for (const f of fs.readdirSync(dir)) if (f.startsWith('.tmp-offclean-') || f.startsWith('.tmp-strip-') || f.startsWith('.tmp-clean-')) {
      try { fs.unlinkSync(path.join(dir, f)); log('收尾', '清理残留临时文件 ' + f) } catch {}
    }
  } catch {}
}

// ────────────────────────── 关闭 / 等待 / 保险丝 / 拉起 ──────────────────────────
function pidAlive(pid) { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
async function waitExit(pid, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) { if (!pidAlive(pid)) return true; await sleep(250) }
  return !pidAlive(pid)
}
function killLeftoverDsh() {
  if (process.platform !== 'win32' || !A.exe) return 0
  const base = path.basename(A.exe)
  let killed = 0
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + base, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)","(\d+)"/)
      if (!m) continue
      const p = Number(m[2])
      if (!p || p === process.pid || p === A.pid) continue
      try { execFileSync('taskkill', ['/PID', String(p), '/F'], { stdio: 'ignore', windowsHide: true }); killed++ } catch {}
    }
  } catch {}
  return killed
}
function forceKill(pid) {
  // Windows 不能带 /T：清理脚本本身是 DSH 的子进程，/T 会连自己一起杀掉，清理和拉起都做不成。
  // DSH web 是单 node 主进程，杀主进程即可；桌面子进程不一定随主进程退出，W2 再扫一遍同名进程。
  if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true }) } catch {} }
  else { try { process.kill(pid, 'SIGKILL') } catch {} }
  const left = killLeftoverDsh()
  if (left) log('P1', '强制结束后清理残留 DSH 进程 ' + left + ' 个')
}
async function closeDsh() {
  if (!A.pid) { log('P1', '未传 --pid，按「DSH 已关闭」处理（手工离线模式）'); return { mode: 'skipped', sd: null } }
  if (!pidAlive(A.pid)) { log('P1', 'pid ' + A.pid + ' 已不存在，视为 DSH 已关闭'); return { mode: 'already-dead', sd: null } }
  const sd = detectSystemdUnit()
  if (sd) {
    try {
      log('P1', '检测到 systemd 单元 ' + sd.unit + (sd.userMode ? '（--user）' : '') + ' 活跃，执行 systemctl stop（避免被自动拉回）')
      execFileSync('systemctl', systemctlArgs(sd.unit, sd.userMode, 'stop'), { stdio: 'ignore', windowsHide: true })
    } catch (e) { log('P1', 'systemctl stop 失败：' + errOf(e) + '，回退为直接信号') }
    if (await waitExit(A.pid, A.graceMs)) {
      await sleep(500)
      if (sd && !A.dryRun) {
        try { execFileSync('systemctl', [...(sd.userMode ? ['--user'] : []), 'is-active', '--quiet', sd.unit], { stdio: 'ignore', windowsHide: true }); throw new Error('DSH 被 systemd 自动重启（Restart=always），离线清理无法安全进行，已取消') } catch (e) { if (String(e.message || '').includes('自动重启')) throw e }
      }
      await sleep(A.settleMs)
      log('P1', 'DSH 已退出（systemd），缓冲 ' + A.settleMs + 'ms 后开始扫描')
      return { mode: sd.userMode ? 'systemd-user' : 'systemd-system', sd }
    }
    log('P1', 'systemd stop 后进程仍在，强制结束')
    forceKill(A.pid)
    if (!(await waitExit(A.pid, 5000))) throw new Error('DSH 无法关闭（强制后仍存活），为避免缓存回写取消清理')
    await sleep(A.settleMs)
    return { mode: sd.userMode ? 'systemd-user+force' : 'systemd-system+force', sd }
  }
  // 非 systemd：Windows 桌面端先走官方退出握手，再回退 taskkill；Linux 用 SIGTERM
  if (process.platform === 'win32') {
    const canHandshake = A.exe && fs.existsSync(A.exe) &&
      (A.electron || !/node(\.exe)?$/i.test(path.basename(A.exe))) &&
      process.env.DSH_OFFCLEAN_NO_HANDSHAKE !== '1'
    if (canHandshake) {
      try {
        const env = { ...process.env }
        delete env.ELECTRON_RUN_AS_NODE
        log('P1', 'Windows 桌面端：发送退出握手 ' + A.exe + ' --dsh-installer-quit')
        spawn(A.exe, ['--dsh-installer-quit'], { detached: true, stdio: 'ignore', windowsHide: true, env }).unref()
        const waitMs = Math.max(A.graceMs, 10000)
        if (await waitExit(A.pid, waitMs)) {
          await sleep(A.settleMs)
          log('P1', 'DSH 已按退出握手退出，缓冲 ' + A.settleMs + 'ms 后开始扫描')
          return { mode: 'quit-handshake', sd: null }
        }
        log('P1', '退出握手 ' + waitMs + 'ms 未退出，回退 taskkill')
      } catch (e) { log('P1', '退出握手失败：' + errOf(e) + '，回退 taskkill') }
    }
    try { execFileSync('taskkill', ['/PID', String(A.pid)], { stdio: 'ignore', windowsHide: true }); log('P1', '已发送 taskkill 优雅关闭（等待 DSH 保存并退出）') } catch (e) { log('P1', 'taskkill 优雅关闭失败（可能已退出）：' + errOf(e)) }
  } else {
    try { process.kill(A.pid, 'SIGTERM'); log('P1', '已发送 SIGTERM（等待 DSH 保存并退出）') } catch (e) { log('P1', 'SIGTERM 失败（可能已退出）：' + errOf(e)) }
  }
  if (await waitExit(A.pid, A.graceMs)) { await sleep(A.settleMs); log('P1', 'DSH 已退出，缓冲 ' + A.settleMs + 'ms 后开始扫描'); return { mode: process.platform === 'win32' ? 'taskkill' : 'signal', sd: null } }
  log('P1', '优雅关闭 ' + A.graceMs + 'ms 未退出，强制结束（此时未保存的内存状态会丢，属预期）')
  forceKill(A.pid)
  if (!(await waitExit(A.pid, 5000))) throw new Error('DSH 无法关闭（强制后仍存活），为避免缓存回写取消清理')
  await sleep(A.settleMs)
  return { mode: process.platform === 'win32' ? 'taskkill+force' : 'signal+force', sd: null }
}
const RESCUE_MIN = Math.max(3, Number(process.env.DSH_OFFCLEAN_RESCUE_MIN || 15))
function deadmanArm(sd) {
  // 死亡保险丝：脚本中途崩溃（比如被断电/被杀），N 分钟后自动把 DSH 拉起来，用户不至于面对黑盒
  try {
    if (process.platform === 'win32') {
      if (!A.exe || !fs.existsSync(A.exe)) return null
      const t = new Date(Date.now() + RESCUE_MIN * 60000)
      const name = 'DshOffCleanRescue-' + A.runId
      const sdDate = t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate())
      const hhmm = pad(t.getHours()) + ':' + pad(t.getMinutes())
      execFileSync('schtasks', ['/create', '/f', '/tn', name, '/sc', 'once', '/sd', sdDate, '/st', hhmm, '/tr', '"' + A.exe + '"'], { stdio: 'ignore', windowsHide: true })
      try { execFileSync('schtasks', ['/query', '/tn', name], { stdio: 'ignore', windowsHide: true }) } catch (e) { log('P1', '保险丝任务查询失败（仍按已布置处理）：' + errOf(e)) }
      log('P1', '保险丝已布置：schtasks ' + name + ' 于 ' + sdDate + ' ' + hhmm + '（' + RESCUE_MIN + ' 分钟后）拉起 DSH')
      return { kind: 'schtasks', name }
    }
    if (sd) {
      const name = 'dsh-offclean-rescue-' + A.runId
      // --collect：单元跑完自动回收，不留在 runtime 目录（reset-failed 的替代口径）
      execFileSync('systemd-run', [...(sd.userMode ? ['--user'] : []), '--collect', '--on-active=' + RESCUE_MIN * 60, '--unit=' + name, 'systemctl', ...(sd.userMode ? ['--user'] : []), 'start', sd.unit], { stdio: 'ignore', windowsHide: true })
      log('P1', '保险丝已布置：systemd 定时器 ' + name + ' 于 ' + RESCUE_MIN + ' 分钟后 ' + (sd.userMode ? '--user ' : '') + 'start ' + sd.unit)
      return { kind: 'systemd-timer', name, userMode: sd.userMode }
    }
  } catch (e) { log('P1', '保险丝布置失败（不阻塞清理）：' + errOf(e)) }
  return null
}
function deadmanCancel(d) {
  if (!d) return
  try {
    if (d.kind === 'schtasks') execFileSync('schtasks', ['/delete', '/f', '/tn', d.name], { stdio: 'ignore', windowsHide: true })
    else if (d.kind === 'systemd-timer') execFileSync('systemctl', [...(d.userMode ? ['--user'] : []), 'stop', d.name + '.timer', d.name + '.service'], { stdio: 'ignore', windowsHide: true })
    log('P8', '保险丝已拆除（DSH 已正常拉起）')
  } catch (e) { log('P8', '保险丝拆除失败（到点自动触发也无害，DSH 已在运行）：' + errOf(e)) }
}
// Windows 拉起前必须剔除派发时注入的 ELECTRON_RUN_AS_NODE / DSH_NODE：
// 否则 DSH NEXT.exe 会以 node 模式启动、无窗口、立即退出（2026-11-20 Windows 实机踩到）。
function restartEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.DSH_NODE
  return env
}
function dshProcessCount() {
  if (process.platform !== 'win32') {
    // Linux桌面/服务端：pgrep -f，用 exe 名或 'dsh web' 作为特征
    try {
      const pat = A.exe ? path.basename(A.exe) : 'dsh web'
      const out = execFileSync('pgrep', ['-f', pat], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      return out.split('\n').filter(Boolean).length
    } catch { return 0 }
  }
  if (!A.exe) return -1
  try {
    const base = path.basename(A.exe)
    // 注意：filter 里不能再包字面引号，否则 tasklist 把引号当成镜像名的一部分，永远 0 命中（2026-11-20 实测）
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + base, '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    const needle = base.toLowerCase()
    return out.split(/\r?\n/).filter((l) => l.toLowerCase().includes(needle)).length
  } catch { return -1 }
}
async function waitDshUp(ms = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (dshProcessCount() > 0) return true
    await sleep(1000)
  }
  return false
}
async function restartDsh(stopInfo) {
  const env = restartEnv()
  const cmd = process.env.DSH_RESTART_CMD || ''
  if (cmd) {
    log('P8', '按 DSH_RESTART_CMD 拉起：' + cmd)
    spawn(cmd, { shell: true, detached: true, stdio: 'ignore', windowsHide: true, env }).unref()
    const verified = await waitDshUp(20000)
    log('P8', verified ? '拉起确认：检测到 DSH 进程' : '拉起未确认：20s 内未检测到 DSH 进程')
    return { mode: 'restart-cmd', verified }
  }
  if (stopInfo.sd) {
    log('P8', 'systemctl start ' + stopInfo.sd.unit + (stopInfo.sd.userMode ? '（--user）' : ''))
    execFileSync('systemctl', systemctlArgs(stopInfo.sd.unit, stopInfo.sd.userMode, 'start'), { stdio: 'ignore', windowsHide: true })
    const t0 = Date.now()
    while (Date.now() - t0 < 15000) {
      try { execFileSync('systemctl', [...(stopInfo.sd.userMode ? ['--user'] : []), 'is-active', '--quiet', stopInfo.sd.unit], { stdio: 'ignore', windowsHide: true }); log('P8', 'systemd 单元已活跃'); return { mode: 'systemd', verified: true } } catch {}
      await sleep(500)
    }
    throw new Error('systemctl start 已执行但 15s 内未观察到活跃')
  }
  if (A.electron && A.exe && fs.existsSync(A.exe)) {
    if (process.platform === 'win32') {
      log('P8', '通过 cmd start 拉起桌面端：' + A.exe)
      spawn('cmd.exe', ['/c', 'start', '', A.exe], { detached: true, stdio: 'ignore', windowsHide: true, env }).unref()
      const verified = await waitDshUp(20000)
      log('P8', verified ? '拉起确认：检测到 DSH NEXT.exe 进程' : '拉起未确认：20s 内未检测到 DSH NEXT.exe 进程（保留保险丝）')
      return { mode: 'start-exe', verified }
    }
    log('P8', '直接拉起桌面端：' + A.exe)
    spawn(A.exe, [], { detached: true, stdio: 'ignore', env }).unref()
    const verified = await waitDshUp(20000)
    log('P8', verified ? '拉起确认：检测到桌面端进程' : '拉起未确认：20s 内未检测到桌面端进程（保留保险丝）')
    return { mode: 'start-exe', verified }
  }
  throw new Error('无法确定 DSH 启动方式：请设 DSH_RESTART_CMD（完整重启命令）后重试，或手工启动 DSH（清理本身已完成）')
}

// ────────────────────────── P4 侧车（归档+水位，与 bin/archive-sessions.mjs 同语义）──────────────────────────
function archiveCleanEvent(e) {
  // 归档副本剥 stream（保留 message.content 等最终内容）——与 appendBatch 的 cleanEvent 一致
  if (!e || e.type !== 'assistant/message') return e
  const d = e.data
  if (!d || d.stream == null) return e
  const c = { ...e, data: { ...d } }
  delete c.data.stream
  return c
}
const CHUNK = Number(process.env.DSH_ARCHIVE_FRAME || 500)
// O3：把「分帧 + 压缩」抽成纯函数，真跑与 dry 用同一份逻辑（dry 只校验不落盘）
function packArchiveChunks(evts) {
  const chunks = [], ranges = []
  let bytes = 0
  for (let i = 0; i < evts.length; i += CHUNK) {
    const part = evts.slice(i, i + CHUNK)
    const body = part.map((e) => JSON.stringify(e)).join('\n') + '\n'
    const chunk = compressZstd(Buffer.from(body, 'utf8'))
    chunks.push({ chunk, from: part[0].seq, to: part[part.length - 1].seq, n: part.length })
    ranges.push([part[0].seq, part[part.length - 1].seq, part.length])
    bytes += chunk.length
  }
  return { chunks, ranges, bytes }
}
function appendArchiveBatch(day, sid, evts, batchNote) {
  evts = evts.map(archiveCleanEvent)
  const dest = path.join(ARCHIVE_DIR, day + '_' + sid + '.日志')
  const side = dest + '.frames.jsonl'
  if (!fs.existsSync(dest)) manifest.push({ orig: dest, created: true }) // 本次新建的归档：回滚时删除而非还原
  const { chunks, ranges, bytes } = packArchiveChunks(evts)
  for (const c of chunks) {
    let off = 0
    try { off = fs.statSync(dest).size } catch {}
    if (off) fs.appendFileSync(dest, c.chunk); else fs.writeFileSync(dest, c.chunk)
    fs.appendFileSync(side, JSON.stringify({ off, len: c.chunk.length, from: c.from, to: c.to, n: c.n, at: Date.now() }) + '\n')
  }
  // seqs.json：合并旧区间 + 诚实 complete（修复 appendBatch 盲目 concat/complete 误标的问题）
  const sq = dest + '.seqs.json'
  let old = []
  try { old = JSON.parse(fs.readFileSync(sq, 'utf8')).ranges || [] } catch {}
  fs.writeFileSync(sq, JSON.stringify({ ranges: mergeRanges(old.concat(ranges)), complete: computeComplete(dest), at: Date.now() }))
  counts.archivedEvents += evts.length
  counts.archivedBytes += bytes
  log('P4/侧车', (batchNote || '') + day + '_' + sid + '：追加 ' + evts.length + ' 条（seq ' + ranges[0][0] + '→' + ranges[ranges.length - 1][1] + '，' + fmtBytes(bytes) + '，帧 ' + ranges.length + '）')
  // 检索明文副本（可选）
  if (plainWriter) {
    const pc = 会话检索配置 ? 会话检索配置(sid) : null
    if (!pc) {
      log('P4/侧车', sid + '：检索配置不可用，跳过明文索引（归档不受影响）')
    } else try {
      const ents = []
      for (const e of evts) {
        const t = textOf(e)
        if (!t.trim()) continue
        ents.push({ seq: e.seq, time: e.time || Date.now(), role: e.data?.message?.role || e.type || '?', type: e.type || '', text: t, arch: dest })
      }
      if (ents.length) {
        const nIdx = plainWriter(sid, () => day, ents, { maxChars: pc.plainMaxChars, keepDays: pc.plainKeepDays, idxKeepDays: pc.idxKeepDays, redact: pc.plainRedact, plainEnabled: pc.plainEnabled })
        if (nIdx) counts.plainIndexed += ents.length
        log('P4/侧车', sid + '：检索配置 明文=' + (pc.plainEnabled ? '开' : '关') + '，txt=' + pc.plainKeepDays + '天，idx=' + (pc.idxKeepDays === 0 ? '永久' : pc.idxKeepDays + '天') + '，截断=' + pc.plainMaxChars + '字')
      }
    } catch (e) { log('P4/侧车', '明文索引写入失败（不影响归档，检索缺这段）：' + errOf(e)) }
  }
  return { dest, n: evts.length, ranges }
}
function sidecarSession(rec, plan, wmMap) {
  const { sid } = rec
  // 先备份该会话已有归档三件套（进回滚清单）再追加：追加无法原子撤销，靠备份回滚
  for (const f of archiveFilesOf(sid)) {
    try { backup(f, 'archive') } catch (e) { fail('归档备份失败（放弃该会话侧车）：' + errOf(e)); return { ok: false, n: 0 } }
    for (const side of [f + '.frames.jsonl', f + '.seqs.json']) {
      if (fs.existsSync(side)) { try { backup(side, 'archive') } catch {} }
    }
  }
  const evts = plan.rows.filter((e) => typeof e.seq === 'number' && e.seq >= 0 && !plan.covered.has(e.seq))
  if (!evts.length) {
    const oldWm = wmMap[sid] ?? -1
    log('P4/侧车', sid + '：无未归档事件（归档覆盖到 seq ' + plan.coveredMax + '），跳过')
    // 归档已覆盖但水位落后（上次异常/历史遗留）：把水位推进到 coveredMax，
    // 否则 P7 复核会判「水位 < 最大 seq」并触发全量回滚（big-2 实测踩到）。
    if (plan.coveredMax > oldWm) {
      wmMap[sid] = plan.coveredMax
      try { writeJsonAtomic(WM_FILE, wmMap, 2) } catch (e) { fail('水位写回失败：' + errOf(e)) }
      log('P4/侧车', sid + '：水位 ' + oldWm + ' → ' + plan.coveredMax + '（归档已覆盖，补推进）')
    }
    return { ok: true, n: 0 }
  }
  const byDay = new Map()
  for (const e of evts) {
    const d = dayOf(e.time)
    if (!byDay.has(d)) byDay.set(d, [])
    byDay.get(d).push(e)
  }
  // 会话头只在「水位还是初始 -1」或「该会话此前完全没有归档」时补一次（与 appendBatch 语义一致）
  if (((wmMap[sid] ?? -1) === -1 || plan.coveredMax === -1) && byDay.size) {
    if (!plan.head || plan.head.type !== 'session') log('P4/侧车', sid + '：缺会话头，跳过补头（不写无 type 的 seq=-1 事件）')
    else {
      const first = [...byDay.keys()][0]
      byDay.get(first).unshift({ ...plan.head, seq: -1 })
    }
  }
  const holes = evts.filter((e) => e.seq <= (wmMap[sid] ?? -1)).length
  if (holes) { counts.holesFilled += holes; log('P4/侧车', sid + '：发现水位以下未覆盖空洞 ' + holes + ' 条（历史漏归档），本次补齐') }
  let ok = true
  for (const [day, list] of byDay) {
    try { appendArchiveBatch(day, sid, list, '') } catch (e) { ok = false; fail('侧车写入失败 ' + sid + ' @' + day + '：' + errOf(e)) }
  }
  if (ok && evts.length) {
    let maxSeq = -1; for (const e of evts) if (e.seq > maxSeq) maxSeq = e.seq
    if (maxSeq > (wmMap[sid] ?? -1)) {
      wmMap[sid] = maxSeq
      try { writeJsonAtomic(WM_FILE, wmMap, 2) } catch (e) { fail('水位写回失败（注意：热路径之后会重复归档，属重复不丢数据）：' + errOf(e)) }
    }
    log('P4/侧车', sid + '：水位推进到 seq ' + wmMap[sid] + '（原文已另存硬闸门通过）')
  }
  return { ok, n: evts.length }
}

// DSH 读会话列表时要求首帧解压后恰好一行 header（assertZstdHeaderFrame）；
// 首帧混进事件会让整个会话被判损坏、从列表静默消失。写回前自己先断言一次。
function assertHeaderFrame(frame, sid) {
  const text = decompressBuf(frame).toString('utf8')
  if (!text || text.indexOf('\n') !== text.length - 1) {
    throw new Error('首帧不是恰好一行（' + sid + '）：' + JSON.stringify(text.slice(0, 80)))
  }
  let obj = null
  try { obj = JSON.parse(text.trim()) } catch (e) { throw new Error('首帧不是合法 JSON（' + sid + '）：' + errOf(e)) }
  if (!obj || obj.type !== 'session') throw new Error('首帧不是 session header（' + sid + '）：type=' + (obj && obj.type))
  return obj
}

// ────────────────────────── P5 清理会话 stream（置空数组，绝不 delete）──────────────────────────
// O3：纯变换，真跑与 dry 共用
function buildCleanLines(rec) {
  let changed = 0, normalized = 0
  const outLines = []
  for (const it of rec.parse.items) {
    const e = it.obj
    if (e && e.type === 'assistant/message' && e.data) {
      if (!Array.isArray(e.data.stream)) { outLines.push(JSON.stringify({ ...e, data: { ...e.data, stream: [] } })); changed++; normalized++; continue }
      if (e.data.stream.length) { outLines.push(JSON.stringify({ ...e, data: { ...e.data, stream: [] } })); changed++; continue }
    }
    outLines.push(it.raw)
  }
  return { outLines, changed, normalized }
}
function cleanSessionStreams(rec) {
  const file = rec.file
  const { outLines, changed, normalized } = buildCleanLines(rec)
  if (!changed) { log('P5/会话', rec.sid + '：无待清理 stream，跳过写回'); return { changed: 0 } }
  const before = fs.statSync(file).size
  backup(file, 'session')
  // 第一帧必须只含 header：DSH 读会话列表时要求首帧恰好是一行 header（assertZstdHeaderFrame），
  // 首帧混进事件会让整个会话被判损坏、从列表静默消失。其余行从第 2 行起按 500 行/帧压缩。
  // E1：批帧规则收口到 lib/frame-pack，和工具箱 frame-writer 由跨包测试比对
  const frames = frameTexts(outLines).map((t) => compressZstd(Buffer.from(t, 'utf8')))
  if (!frames.length) throw new Error('没有可写帧（' + rec.sid + '）')
  assertHeaderFrame(frames[0], rec.sid)
  const intended = Buffer.concat(frames)
  const tmp = file + '.tmp-offclean-' + process.pid + '-' + Date.now()
  fs.writeFileSync(tmp, intended)
  fs.renameSync(tmp, file)
  const after = fs.statSync(file).size
  counts.streamEventsCleaned += changed
  counts.sessionsCleaned++
  counts.bytesBefore += before
  counts.bytesAfter += after
  log('P5/会话', rec.sid + '：置空 stream ' + changed + ' 条（其中补齐缺失 stream 字段 ' + normalized + ' 条），' + fmtBytes(before) + ' → ' + fmtBytes(after))
  return { changed, outLines, intended, normalized }
}

// ────────────────────────── P6 清理归档内残留 stream ──────────────────────────
function cleanArchiveFile(name) {
  const file = path.join(ARCHIVE_DIR, name)
  const st = fs.statSync(file)
  const idx = readFramesIdx(file)
  const chunks = []
  let changed = false
  try {
    if (idx.length) {
      const buf = fs.readFileSync(file)
      for (const fr of idx) {
        const raw = decompressBuf(buf.subarray(fr.off, fr.off + fr.len)).toString('utf8')
        const evs = []
        for (const line of raw.split('\n')) { if (!line.trim()) continue; try { evs.push(JSON.parse(line)) } catch {} }
        if (evs.some((e) => e && e.type === 'assistant/message' && e.data && e.data.stream != null)) changed = true
        const cleaned = evs.map(archiveCleanEvent)
        chunks.push({ body: Buffer.from(cleaned.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'), from: fr.from, to: fr.to, n: cleaned.length })
      }
    } else {
      const raw = decompressBuf(fs.readFileSync(file)).toString('utf8')
      const evs = []
      for (const line of raw.split('\n')) { if (!line.trim()) continue; try { evs.push(JSON.parse(line)) } catch {} }
      if (evs.some((e) => e && e.type === 'assistant/message' && e.data && e.data.stream != null)) changed = true
      const cleanedLegacy = evs.map(archiveCleanEvent)
      for (let i = 0; i < cleanedLegacy.length; i += CHUNK) {
        const part = cleanedLegacy.slice(i, i + CHUNK)
        if (!part.length) continue
        chunks.push({ body: Buffer.from(part.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'), from: part[0].seq, to: part[part.length - 1].seq, n: part.length })
      }
    }
  } catch (e) { fail('归档解压失败，跳过该文件（不动它）：' + name + '：' + errOf(e)); return { changed: false, error: true } }
  if (!changed) return { changed: false }
  backup(file, 'archive')
  for (const side of [file + '.frames.jsonl', file + '.seqs.json']) {
    if (fs.existsSync(side)) { try { backup(side, 'archive') } catch {} }
  }
  const parts = [], newFrames = []
  let off = 0
  for (const c of chunks) {
    const z = compressZstd(c.body)
    parts.push(z)
    newFrames.push({ off, len: z.length, from: c.from, to: c.to, n: c.n, at: Date.now() })
    off += z.length
  }
  const tmp = file + '.tmp-offclean-' + process.pid + '-' + Date.now()
  fs.writeFileSync(tmp, Buffer.concat(parts))
  fs.renameSync(tmp, file)
  fs.writeFileSync(file + '.frames.jsonl', newFrames.map((f) => JSON.stringify(f)).join('\n') + '\n')
  const merged = mergeRanges(newFrames.map((f) => [f.from, f.to, f.n]))
  fs.writeFileSync(file + '.seqs.json', JSON.stringify({ ranges: merged, complete: computeComplete(file), at: Date.now() }))
  counts.archivesCleaned++
  counts.archiveFramesCleaned += newFrames.length
  log('P6/归档', name + '：重写 ' + newFrames.length + ' 帧（剥残留 stream），' + fmtBytes(st.size) + ' → ' + fmtBytes(fs.statSync(file).size))
  return { changed: true, frames: newFrames.length }
}

// ────────────────────────── P7 校验 ──────────────────────────
function verifySessionFile(rec, expected) {
  const file = rec.file
  let text = ''
  try { text = readSessionText(file) } catch (e) { return { ok: false, reason: '重读解压失败：' + errOf(e) } }
  // E2：分段比对，避免把整份内容再拼出一个 want 字符串（大会话会同时占三份内存）
  const rawLines = text.split('\n')
  if (!text.endsWith('\n')) return { ok: false, reason: '文件末尾缺少换行（写入不完整）' }
  const have = rawLines.length && rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines
  if (expected && expected.intended) {
    const want = expected.outLines
    if (have.length !== want.length) return { ok: false, reason: '行数不符：' + have.length + '≠' + want.length }
    for (let i = 0; i < have.length; i += 2000) {
      const n = Math.min(2000, have.length - i)
      if (have.slice(i, i + n).join('\n') !== want.slice(i, i + n).join('\n')) {
        return { ok: false, reason: '第 ' + (i + 1) + ' 行起内容与预期不一致' }
      }
    }
  }
  const lines = have.filter((l) => l.trim())
  let headSeen = false, amTotal = 0, amBad = 0, badLines = 0
  for (const line of lines) {
    let e = null
    try { e = JSON.parse(line) } catch { badLines++; continue }
    if (e.type === 'session') headSeen = true
    if (e.type === 'assistant/message') {
      amTotal++
      if (!e.data || !Array.isArray(e.data.stream)) amBad++
    }
  }
  if (!headSeen) return { ok: false, reason: '缺少 session 头事件' }
  if (badLines > (rec.parse.bad || 0)) return { ok: false, reason: '新出现 ' + (badLines - (rec.parse.bad || 0)) + ' 个坏行（旧坏行应原样保留，不应产生新坏行）' }
  if (amBad) return { ok: false, reason: amBad + ' 条 assistant/message 的 data.stream 不是数组（seed 校验会拒载）' }
  return { ok: true, lines: lines.length, assistantMessages: amTotal }
}
function verifyArchiveFile(file, opts) {
  const { ranges, complete } = readSeqs(file)
  const idx = readFramesIdx(file)
  let size = 0
  try { size = fs.statSync(file).size } catch { return { ok: false, reason: '文件不存在' } }
  let flen = 0
  for (const fr of idx) { flen += fr.len || 0; if (fr.off + fr.len > size) return { ok: false, reason: 'frames.jsonl 越界（off+len > 文件大小）' } }
  if (idx.length && flen !== size) return { ok: false, reason: 'frames.jsonl 字节和 ' + flen + ' ≠ 文件大小 ' + size }
  let text = ''
  try { text = decompressBuf(fs.readFileSync(file)).toString('utf8') } catch (e) { return { ok: false, reason: '整包解压失败：' + errOf(e) } }
  let n = 0, streamLeft = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    n++
    try { const e = JSON.parse(line); if (opts.checkNoStream && e && e.type === 'assistant/message' && e.data && e.data.stream != null) streamLeft++ } catch { return { ok: false, reason: '存在无法解析的行' } }
  }
  if (opts.checkNoStream && streamLeft) return { ok: false, reason: streamLeft + ' 条 assistant/message 仍带 stream' }
  return { ok: true, events: n, complete, ranges: ranges.length }
}

// ────────────────────────── 报告 ──────────────────────────
function buildReport(extra) {
  // O5：P5 因侧车失败跳过清理的会话单独计数，报告里明确标「部分完成」
  const partialSessions = sessionReports.filter((r) => r.skipped === 'sidecar-failed').length
  return {
    runId: A.runId, dry: A.dryRun, ok: okFlag, partial: partialSessions > 0, partialSessions, at: tsLocal(),
    home: HOME, platform: process.platform, node: process.version, electron: A.electron,
    counts, sessions: sessionReports, archives: archiveReports, restart: restartReport, ...extra,
  }
}
const sessionReports = []
const archiveReports = []
let restartReport = null
let stopInfo = null, deadman = null

// ────────────────────────── 主流程 ──────────────────────────
async function main() {
  // O4：同 runId 且上次未完成 → 续跑；否则照旧把旧目录挪成 .prev
  let resume = null
  try {
    if (!A.dryRun && fs.existsSync(CKPT_FILE)) {
      const cp = JSON.parse(fs.readFileSync(CKPT_FILE, 'utf8'))
      if (cp && cp.runId === A.runId && cp.status === 'running') resume = cp
    }
  } catch {}
  if (!resume && fs.existsSync(RUN_DIR)) {
    try { const prev = RUN_DIR + '.prev-' + stamp(); fs.renameSync(RUN_DIR, prev); log('启动', '已存在同名运行目录，挪为 ' + path.basename(prev)) } catch {}
    manifest = []
  }
  fs.mkdirSync(RUN_DIR, { recursive: true })
  ckpt = resume || { runId: A.runId, status: 'running', updatedAt: Date.now(), sidecar: {}, clean: {}, manifest: [] }
  if (resume) {
    manifest = Array.isArray(resume.manifest) ? resume.manifest : []
    log('启动', '从 checkpoint 续跑：侧车已完成 ' + Object.keys(ckpt.sidecar || {}).length + " 个、清理已完成 " + Object.keys(ckpt.clean || {}).length + ' 个')
  } else saveCheckpoint()
  log('启动', '离线深度清理 runId=' + A.runId + (A.dryRun ? '（dry-run 预检：不关机、不写数据）' : '') )
  log('环境', 'HOME=' + HOME + '  platform=' + process.platform + '  node=' + process.version + (process.env.DSH_NODE ? '  DSH_NODE=' + process.env.DSH_NODE : '') + '  fzstd=' + (fzstdDecompress ? 'vendor可用' : '缺') + '  zstdCompressSync=' + hasZstdSync + '  zstdCLI=' + (zstdCliOk === true ? '可用' : zstdCliOk === false ? '缺' : '未探测'))
  setStatus('P0', '预检')

  // ── P0 预检（不通过绝不关机）──
  try { compressZstd(Buffer.from('dsh-offclean-probe')) ; log('P0', '压缩能力探测通过') } catch (e) { fail('预检失败：' + errOf(e)); okFlag = false; fs.writeFileSync(REPORT_FILE, JSON.stringify(buildReport({ phase: 'P0' }))); setStatus('P0', '预检', '预检失败'); process.exit(2) }
  try { decompressBuf(compressZstd(Buffer.from('roundtrip-probe'))).toString(); log('P0', '压缩/解压回环通过') } catch (e) { fail('预检失败（回环）：' + errOf(e)); okFlag = false; fs.writeFileSync(REPORT_FILE, JSON.stringify(buildReport({ phase: 'P0' }))); process.exit(2) }
  if (!fs.existsSync(SESS)) { fail('预检失败：会话目录不存在 ' + SESS); okFlag = false; fs.writeFileSync(REPORT_FILE, JSON.stringify(buildReport({ phase: 'P0' }))); process.exit(2) }
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true })
  fs.mkdirSync(RUNS_DIR, { recursive: true })
  try { const s = fs.statfsSync(HOME); const freeMB = (s.bavail * s.bsize) / 1048576; log('P0', '磁盘可用 ' + freeMB.toFixed(0) + 'MB' + (freeMB < 200 ? '（偏小，建议先清理磁盘）' : '')) } catch {}
  // 防重复派发：锁文件 5 分钟内心跳有效
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lk = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'))
      if (lk && lk.runId !== A.runId && Date.now() - lk.updatedAt < 5 * 60000) {
        fail('已有离线清理任务在运行（' + lk.runId + '），本次不启动'); okFlag = false
        fs.writeFileSync(REPORT_FILE, JSON.stringify(buildReport({ phase: 'P0' })))
        process.exit(5)
      }
      if (lk && lk.runId !== A.runId) log('P0', '发现过期锁（' + lk.runId + '，' + Math.round((Date.now() - lk.updatedAt) / 60000) + ' 分钟前），视为上次异常退出，接管')
    }
  } catch {}
  try { fs.writeFileSync(LOCK_FILE, JSON.stringify({ runId: A.runId, pid: process.pid, updatedAt: Date.now() })) } catch {}
  log('P0', '预检通过，锁已取得')

  // ── P1/P2 关闭 DSH（dry-run 跳过）──
  if (!A.dryRun) {
    setStatus('P1', '关闭 DSH')
    deadman = deadmanArm(detectSystemdUnit())
  if (!deadman) log('P1', '本环境没有自动拉起兜底（Windows 需 --exe；Linux 需 systemd），清理后请人工确认 DSH 已启动')
    stopInfo = await closeDsh()
    log('P2', '关闭阶段完成（mode=' + stopInfo.mode + '），开始扫描')
  } else {
    log('P1', 'dry-run：不关闭 DSH')
  }

  // ── P3 扫描 ──
  setStatus('P3', '扫描会话')
  let wmMap = {}
  try { wmMap = JSON.parse(fs.readFileSync(WM_FILE, 'utf8')) || {} } catch { log('P3', '水位文件缺失/不可解析，按空水位处理（全部事件都会补归档）') }
  if (typeof wmMap !== 'object' || Array.isArray(wmMap)) wmMap = {}
  const sessions = listSessions()
  counts.sessionsScanned = sessions.length
  log('P3', '扫描到 ' + sessions.length + ' 个会话文件（SESS=' + SESS + '）')
  const recs = []
  for (const s of sessions) {
    try {
      const st = fs.statSync(s.file)
      const parse = parseSessionFile(s.file)
      const sid = parse.sid || s.dirId
      const { covered, coveredMax } = coveredOf(sid)
      const rows = parse.items.filter((it) => it.obj && typeof it.obj.seq === 'number' && it.obj.seq >= 0).map((it) => it.obj)
      const toArch = rows.filter((e) => !covered.has(e.seq))
      const holes = toArch.filter((e) => e.seq <= (wmMap[sid] ?? -1)).length
      const rec = { ...s, sid, stat: st, parse, covered, coveredMax, rows, toArch, holes }
      recs.push(rec)
      log('P3', (sid.slice(0, 18)) + '  ' + path.relative(HOME, s.file) + '：' + fmtBytes(st.size) + '，事件 ' + rows.length + ' 条（坏行 ' + parse.bad + '），含 stream 待清 ' + parse.streamEvents + ' 条，未归档 ' + toArch.length + ' 条' + (holes ? '（含水位下空洞 ' + holes + ' 条）' : '') + '，归档覆盖至 seq ' + coveredMax + '，水位 ' + (wmMap[sid] ?? -1))
    } catch (e) { fail('扫描失败 ' + s.file + '：' + errOf(e)) }
  }
  if (A.dryRun) {
    // O3：dry 不再在 P3 直接返回——用与真跑相同的 packArchiveChunks / buildCleanLines 走一遍，
    // 只校验（压缩、首帧结构、JSON 可解析）不落盘，把「dry 通过≠真跑通过」的盲区补上。
    let simFrames = 0, simStream = 0
    for (const r of recs) {
      try {
        if (r.toArch.length) {
          const packed = packArchiveChunks(r.toArch.map(archiveCleanEvent))
          simFrames += packed.chunks.length
        }
        if (r.parse.streamEvents || r.parse.bad) {
          const t = buildCleanLines(r)
          if (t.changed) {
            const frames = [compressZstd(Buffer.from(t.outLines[0] + '\n'))]
            for (let i = 1; i < t.outLines.length; i += CHUNK) frames.push(compressZstd(Buffer.from(t.outLines.slice(i, i + CHUNK).join('\n') + '\n')))
            assertHeaderFrame(frames[0], r.sid)
            for (const line of t.outLines) JSON.parse(line) // 变换后每行仍必须是合法 JSON
            simStream += t.changed
          }
        }
      } catch (e) { fail('dry 预检失败 ' + r.sid + '：' + errOf(e)) }
    }
    okFlag = counts.errors === 0
    for (const r of recs) {
      const pc = 会话检索配置 ? 会话检索配置(r.sid) : null
      log('P3', (r.sid.slice(0, 18)) + ' 检索配置：' + (pc ? '明文=' + (pc.plainEnabled ? '开' : '关') + '，txt=' + pc.plainKeepDays + '天，idx=' + (pc.idxKeepDays === 0 ? '永久' : pc.idxKeepDays + '天') + '，截断=' + pc.plainMaxChars + '字' : '不可用（跳过明文索引）'))
    }
    const rep = buildReport({ phase: 'P3-dry', simulated: { archiveFrames: simFrames, streamEvents: simStream }, plan: recs.map((r) => ({ sid: r.sid, file: path.relative(HOME, r.file), size: r.stat.size, events: r.rows.length, streamEvents: r.parse.streamEvents, toArchive: r.toArch.length, holes: r.holes, coveredMax: r.coveredMax, watermark: wmMap[r.sid] ?? -1 })) })
    fs.writeFileSync(REPORT_FILE, JSON.stringify(rep, null, 2))
    log('P3', 'dry-run 完成：待侧车 ' + recs.reduce((a, r) => a + r.toArch.length, 0) + ' 条（模拟分帧 ' + simFrames + '）、待清理 stream ' + recs.reduce((a, r) => a + r.parse.streamEvents, 0) + ' 条（模拟变换 ' + simStream + '），错误 ' + counts.errors + '。未写入任何数据。报告：' + REPORT_FILE)
    setStatus('P9', '完成', 'dry-run 预检完成，未修改任何文件')
    okFlag = counts.errors === 0
    writeBrief()
    try { fs.unlinkSync(LOCK_FILE) } catch {}
    process.exit(okFlag ? 0 : 2)
  }

  // ── P4 侧车（先另存后清理的硬闸门）──
  setStatus('P4', '侧车归档')
  if (fs.existsSync(WM_FILE)) { try { backup(WM_FILE, 'archive') } catch (e) { log('P4', '水位文件备份失败（继续，写回失败会显式报错）：' + errOf(e)) } }
  const sidecarOk = new Map()
  for (const rec of recs) {
    setStatus('P4', '侧车归档', rec.sid)
    if (ckpt.sidecar[rec.sid]) { sidecarOk.set(rec.sid, true); log('P4', rec.sid + '：checkpoint 已完成侧车，跳过'); continue }
    try {
      const r = sidecarSession(rec, { rows: rec.rows, head: rec.parse.head, covered: rec.covered, coveredMax: rec.coveredMax }, wmMap)
      sidecarOk.set(rec.sid, !!r.ok)
      counts.archivedSessions += r.ok && r.n ? 1 : 0
      if (r.ok) { ckpt.sidecar[rec.sid] = true; saveCheckpoint() }
    } catch (e) { sidecarOk.set(rec.sid, false); fail('侧车异常 ' + rec.sid + '：' + errOf(e)) }
  }

  // ── P5 清理会话 data stream（只清侧车成功的会话）──
  setStatus('P5', '清理会话 stream')
  for (const rec of recs) {
    setStatus('P5', '清理会话 stream', rec.sid)
    if (ckpt.clean[rec.sid]) { log('P5/会话', rec.sid + '：checkpoint 已完成清理，跳过'); continue }
    try {
      if (!rec.parse.streamEvents && !rec.parse.bad) { ckpt.clean[rec.sid] = true; saveCheckpoint(); log('P5/会话', rec.sid + '：无 stream 待清'); continue }
      if (sidecarOk.get(rec.sid) === false && rec.toArch.length) {
        counts.sessionsSkipped++
        log('P5/会话', rec.sid + '：侧车未成功且有未归档事件 → 保留 stream 不清理（先另存后清理硬闸门）')
        sessionReports.push({ sid: rec.sid, skipped: 'sidecar-failed' })
        continue
      }
      const r = cleanSessionStreams(rec)
      rec.cleanResult = r
      if (r.changed) sessionReports.push({ sid: rec.sid, cleaned: r.changed, normalized: r.normalized || 0, bytesBefore: rec.stat.size, bytesAfter: fs.statSync(rec.file).size })
      ckpt.clean[rec.sid] = true
      saveCheckpoint()
    } catch (e) { fail('清理会话失败 ' + rec.sid + '：' + errOf(e)); sessionReports.push({ sid: rec.sid, error: errOf(e) }) }
    cleanTmpLeftovers(path.dirname(rec.file))
  }

  // ── P6 清理归档残留 stream ──
  if (!A.skipArchiveClean) {
    setStatus('P6', '清理归档 stream')
    let names = []
    try { names = fs.readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith('.日志') && !f.includes('.bak-')) } catch (e) { fail('归档目录不可读：' + errOf(e)) }
    log('P6', '扫描归档 ' + names.length + ' 个')
    for (const name of names) {
      try {
        const r = cleanArchiveFile(name)
        archiveReports.push({ file: name, changed: !!r.changed, error: !!r.error })
      } catch (e) { fail('归档清理失败 ' + name + '：' + errOf(e)); archiveReports.push({ file: name, error: errOf(e) }) }
    }
  } else log('P6', '已按参数跳过归档 stream 清理')

  // ── P7 全量校验 ──
  setStatus('P7', '校验')
  const verify = { sessions: [], archives: [], allOk: true }
  for (const rec of recs) {
    if (!rec.cleanResult || !rec.cleanResult.changed) continue
    const r = verifySessionFile(rec, rec.cleanResult)
    verify.sessions.push({ sid: rec.sid, ok: r.ok, reason: r.reason || '', lines: r.lines, assistantMessages: r.assistantMessages })
    log('P7', '会话 ' + rec.sid + ' 校验：' + (r.ok ? '通过（' + r.lines + ' 行 / assistant ' + r.assistantMessages + ' 条 / stream 全为数组）' : '失败：' + r.reason))
    if (!r.ok) verify.allOk = false
  }
  if (!A.skipArchiveClean) {
    for (const name of fs.existsSync(ARCHIVE_DIR) ? fs.readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith('.日志') && !f.includes('.bak-')) : []) {
      const file = path.join(ARCHIVE_DIR, name)
      const changedByUs = archiveReports.find((a) => a.file === name && a.changed)
      const r = verifyArchiveFile(file, { checkNoStream: true })
      if (!changedByUs && r.ok) continue
      verify.archives.push({ file: name, ok: r.ok, reason: r.reason || '', events: r.events, complete: r.complete })
      if (!r.ok && changedByUs) { verify.allOk = false; log('P7', '归档 ' + name + ' 校验失败：' + r.reason) }
      else if (!r.ok) log('P7', '归档 ' + name + ' 校验未过（本次未改写它，属历史遗留，不判失败）：' + r.reason)
    }
  }
  // 水位复核：侧车成功的会话水位必须 ≥ 本文件最大 seq
  for (const rec of recs) {
    if (!sidecarOk.get(rec.sid) || !rec.rows.length) continue
    let maxSeq = -1; for (const e of rec.rows) if (e.seq > maxSeq) maxSeq = e.seq
    if ((wmMap[rec.sid] ?? -1) < maxSeq) { verify.allOk = false; log('P7', '水位复核失败：' + rec.sid + ' 水位 ' + (wmMap[rec.sid] ?? -1) + ' < 最大 seq ' + maxSeq) }
  }
  log('P7', verify.allOk ? '校验全部通过' : '校验存在失败项')
  if (!verify.allOk) {
    await rollback('校验未通过')
    okFlag = false
    fs.writeFileSync(REPORT_FILE, JSON.stringify(buildReport({ phase: 'P7-rolled-back', verify }), null, 2))
    if (!A.restartNone) {
      try {
        setStatus('P8', '拉起 DSH', '回滚后拉起')
        restartReport = await restartDsh(stopInfo || {})
        if (restartReport.verified === false) log('P8', '拉起未确认，保留保险丝兜底')
        else deadmanCancel(deadman)
        log('P8', '已发出拉起命令（' + restartReport.mode + '）')
      }
      catch (e) { log('P8', '拉起失败（保险丝 ' + RESCUE_MIN + ' 分钟后兜底 / 或手工启动）：' + errOf(e)) }
    }
    ckpt.status = 'rolled-back'; saveCheckpoint()
    setStatus('P9', '失败(已回滚)', '校验未通过，已全量回滚')
    fs.writeFileSync(REPORT_FILE, JSON.stringify(buildReport({ phase: 'P9-rolled-back', verify }), null, 2))
    log('结束', '清理失败，已回滚到清理前状态，runId=' + A.runId)
    writeBrief()
    try { fs.unlinkSync(LOCK_FILE) } catch {}
    process.exit(3)
  }

  // ── P8 拉起 DSH ──
  if (!A.restartNone) {
    setStatus('P8', '拉起 DSH')
    try {
      restartReport = await restartDsh(stopInfo || {})
      if (restartReport.verified === false) log('P8', '拉起未确认，保留保险丝（' + RESCUE_MIN + ' 分钟后由计划任务兜底拉起）')
      else deadmanCancel(deadman)
      log('P8', '已发出拉起命令（' + restartReport.mode + '），DSH 启动后即可在面板查看本报告')
    } catch (e) {
      log('P8', '拉起失败：' + errOf(e))
      log('P8', '手工拉起指引：Windows 桌面端双击 DSH 图标；Linux systemd：systemctl start dsh.service；或设 DSH_RESTART_CMD 后重跑。清理数据本身已完成且校验通过。')
      restartReport = { mode: 'failed', error: errOf(e) }
    }
  } else log('P8', 'restart-mode=none：不拉起（测试/手工模式）')

  // ── P9 收尾 ──
  ckpt.status = 'done'; saveCheckpoint()
  okFlag = counts.errors === 0
  fs.writeFileSync(REPORT_FILE, JSON.stringify(buildReport({ phase: 'P9', verify, stopMode: stopInfo ? stopInfo.mode : 'skipped', deadman: deadman ? deadman.kind : null, rescueMin: RESCUE_MIN }), null, 2))
  for (const rec of recs) cleanTmpLeftovers(path.dirname(rec.file))
  cleanTmpLeftovers(ARCHIVE_DIR)
  // 运行目录只留最近 30 份
  try {
    const dirs = fs.readdirSync(RUNS_DIR).filter((d) => /^[\w.\-]+$/.test(d)).sort()
    while (dirs.length > 30) { const d = dirs.shift(); try { fs.rmSync(path.join(RUNS_DIR, d), { recursive: true, force: true }) } catch {} }
  } catch {}
  setStatus('P9', '完成', '侧车 ' + counts.archivedEvents + ' 条 / 清理会话 ' + counts.sessionsCleaned + ' 个 / 清理归档 ' + counts.archivesCleaned + ' 个 / 错误 ' + counts.errors)
  log('结束', '完成：会话扫描 ' + counts.sessionsScanned + '，侧车 ' + counts.archivedEvents + ' 条（补洞 ' + counts.holesFilled + '），清理 stream ' + counts.streamEventsCleaned + ' 条（会话 ' + counts.sessionsCleaned + ' 个，跳过 ' + counts.sessionsSkipped + '），归档重写 ' + counts.archivesCleaned + ' 个，校验通过，DSH 拉起 ' + (restartReport ? restartReport.mode : 'none') + '。runId=' + A.runId)
  writeBrief()
  try { fs.unlinkSync(LOCK_FILE) } catch {}
  process.exit(okFlag ? 0 : 3)
}

main().catch(async (e) => {
  try { log('异常', (e && (e.stack || e.message)) || String(e)) } catch {}
  fail('未捕获异常：' + errOf(e))
  if (!A.dryRun && manifest.length) { try { await rollback('未捕获异常') } catch {} }
  if (!A.dryRun && !A.restartNone) {
    try {
      restartReport = await restartDsh(stopInfo || {})
      if (restartReport.verified === false) log('异常', '拉起未确认，保留保险丝兜底')
      else deadmanCancel(deadman)
      log('异常', '已尝试拉起 DSH（' + restartReport.mode + '）')
    } catch (e2) { log('异常', '拉起失败（保险丝 ' + RESCUE_MIN + ' 分钟后兜底 / 或手工启动）：' + errOf(e2)) }
  }
  try { fs.writeFileSync(REPORT_FILE, JSON.stringify(buildReport({ phase: 'crash', fatal: errOf(e) }), null, 2)) } catch {}
  try { fs.unlinkSync(LOCK_FILE) } catch {}
  process.exit(3)
})
