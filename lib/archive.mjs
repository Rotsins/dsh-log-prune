// 5.4（2026-11-19）：归档/镜像/会话日志读取 —— 从 index.js 抽出的模块（只搬不改）。
// 解压能力由工具箱注入（setZstd），worker 路径与裁切插件同目录。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import zlib from 'node:zlib'
// C1（2026-11-19）：Node 20 / 22.0–22.14 无 zstdDecompressSync 命名导出，命名导入会让本模块
// 链接期抛 SyntaxError、整条插件加载失败。改默认导入再解构，拿不到就是 undefined，下方
// readZstd 里 `typeof zstdDecompressSync === 'function'` 的保护才来得及生效。
const { zstdDecompressSync } = zlib
import { extractSeqTexts } from './plain.mjs'
import { dayOf } from './daycut.mjs'
import { sessionFileName } from './session-file.mjs'
import { resolveHome } from './home.mjs'

const HOME = resolveHome()
export const ARCHIVE_DIR = process.env.DSH_LOG_ARCHIVE ?? path.join(HOME, '记忆', '日志存档')
export const MIRROR_DIR = process.env.DSH_LOG_MIRROR ?? path.join(HOME, '记忆', '镜像')
const CACHE_MS = 30000
const FILE_CACHE_MAX = 6
// P2：解压后文本与缓存都按字节设上限。zstd 对 JSON 日志常见 10~20 倍压缩比，
// 只限压缩前大小挡不住 2GB 归档解出 20GB 文本。
const MAX_TEXT_BYTES = Math.max(1, Number(process.env.DSH_ARCHIVE_MAX_TEXT_MB) || 512) * 1024 * 1024
const MAX_CACHE_BYTES = Math.max(16, Number(process.env.DSH_ARCHIVE_CACHE_MB) || 256) * 1024 * 1024
function checkTextSize(buf, where) {
  const n = (buf && buf.length) || 0
  if (n > MAX_TEXT_BYTES) throw new Error(where + ' 解压后约 ' + Math.round(n / 1048576) + 'MB，超过上限 ' + Math.round(MAX_TEXT_BYTES / 1048576) + 'MB（可调 DSH_ARCHIVE_MAX_TEXT_MB）')
  return buf
}

// 帧索引：归档脚本追加时写的 <file>.frames.jsonl（{off,len,from,to}）。
export function framesFor(file) {
  try {
    const f = file + '.frames.jsonl'
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter((x) => x && Number.isFinite(x.off) && Number.isFinite(x.len) && Number.isFinite(x.from) && Number.isFinite(x.to))
  } catch { return [] }
}

// O10：区间表代理
export class SeqRanges {
  constructor(ranges) {
    this.ranges = ranges
    this.sorted = ranges.slice().sort((a, b) => a[0] - b[0])
  }
  _find(s) {
    let lo = 0, hi = this.sorted.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const r = this.sorted[mid]
      if (s < r[0]) hi = mid - 1
      else if (s > r[1]) lo = mid + 1
      else return r
    }
    return null
  }
  has(s) { return !!this._find(s) }
  get(s) { const r = this._find(s); return r ? { file: r[3], day: r[4] } : undefined }
  get size() { return this.ranges.reduce((a, r) => a + (r[2] || 0), 0) }
  *values() { for (const r of this.ranges) yield { file: r[3], day: r[4] } }
}

export function dayFromArchiveName(f) {
  const m = /^(\d{8})_/.exec(String(f || ''))
  return m ? m[1] : ''
}

export function seqRangesFor(full) {
  try {
    const j = JSON.parse(fs.readFileSync(full + '.seqs.json', 'utf8'))
    const arr = Array.isArray(j.ranges) ? j.ranges : []
    return arr.filter((r) => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1])).map((r) => [r[0], r[1], r[2] || 0])
  } catch { return null }
}

export function seqRangesComplete(full) {
  let j = null
  try { j = JSON.parse(fs.readFileSync(full + '.seqs.json', 'utf8')) } catch { return false }
  if (j && j.complete === true) return true
  let size = 0
  try { size = fs.statSync(full).size } catch { return false }
  const frames = framesFor(full)
  if (!frames.length) return false
  const sum = frames.reduce((a, f) => a + (f.len || 0), 0)
  return sum === size
}

export function rangesOfMap(fm) {
  const seqs = [...fm.keys()].sort((a, b) => a - b)
  const out = []
  let start = null, end = null, n = 0
  for (const s of seqs) {
    if (start === null) { start = end = s; n = 1; continue }
    if (s === end + 1) { end = s; n++; continue }
    out.push([start, end, n]); start = end = s; n = 1
  }
  if (start !== null) out.push([start, end, n])
  return out
}

// 组合视图：镜像 Map + 归档（Map 或 SeqRanges）+ 会话日志兜底补进来的条目
export class ArchiveView {
  constructor(mirror, archive) { this.mirror = mirror; this.archive = archive; this.extra = new Map() }
  has(s) { return this.mirror.has(s) || this.archive.has(s) || this.extra.has(s) }
  get(s) { return this.extra.get(s) || this.archive.get(s) || this.mirror.get(s) }
  set(s, v) { this.extra.set(s, v) }
  get size() { return this.mirror.size + this.archive.size + this.extra.size }
  *values() { yield* this.mirror.values(); yield* this.archive.values(); yield* this.extra.values() }
}

import { unzstd as safeUnzstd } from './zstd-safe.mjs'

let zstdDecompressFn = null
let zstdVendorPath = ''
export function setZstd({ decompress, vendorPath } = {}) {
  if (typeof decompress === 'function') zstdDecompressFn = decompress
  if (vendorPath) zstdVendorPath = String(vendorPath)
}

let zstdOk = null
function canZstd() {
  if (zstdOk !== null) return zstdOk
  try { execFileSync('zstd', ['--version'], { stdio: 'ignore', windowsHide: true }); zstdOk = true } catch { zstdOk = false }
  return zstdOk
}

// 读 zstd 文件：DSH 的日志是多帧拼接，内置 zstdDecompressSync 只解第一帧还当成功。
// B3：顺序统一为 fzstd → 系统 zstd CLI → 内置——CLI 能解全多帧，内置只能解第一帧，
// 原顺序在 fzstd 缺席时会先走「只解第一帧还当成功」的路径（静默截断）。
export function readZstd(file) {
  const buf = fs.readFileSync(file)
  if (typeof zstdDecompressFn === 'function') {
    try { return checkTextSize(Buffer.from(zstdDecompressFn(buf)), file).toString('utf8') } catch (e) { if (/超过上限/.test(String(e && e.message))) throw e }
  }
  // S1：CLI/内置兜底统一走 zstd-safe（顺序与上限都在那一处）
  try { return checkTextSize(safeUnzstd(buf), file).toString('utf8') } catch (e) {
    if (/超过上限/.test(String(e && e.message))) throw e
    throw new Error('zstd 解压失败：' + file + '（' + String(e && e.message) + '）')
  }
}

const DECOMPRESS_WORKER = new URL('./decompress-worker.mjs', import.meta.url)
export async function readEntriesAsync(file) {
  let size = 0
  try { size = fs.statSync(file).size } catch {}
  if (size < 8 * 1024 * 1024) return { text: readZstd(file) }
  try {
    const { Worker } = await import('node:worker_threads')
    return await new Promise((resolve, reject) => {
      const w = new Worker(DECOMPRESS_WORKER, { workerData: { file, vendorPath: zstdVendorPath, maxTextBytes: MAX_TEXT_BYTES } })
      const done = (fn, v) => { try { w.terminate() } catch {}; fn(v) }
      const timer = setTimeout(() => done(reject, new Error('worker 解压超时')), 180000)
      w.once('message', (m) => { clearTimeout(timer); m && m.ok ? done(resolve, { entries: m.entries }) : done(reject, new Error((m && m.error) || 'worker 解压失败')) })
      w.once('error', (err) => { clearTimeout(timer); done(reject, err) })
      w.once('exit', (code) => { if (code !== 0) { clearTimeout(timer); done(reject, new Error('worker 退出 ' + code)) } })
    })
  } catch (e) {
    console.warn('[log-prune] worker 解压失败，回落同步（可能卡顿）：' + (e?.message ?? e))
    return { text: readZstd(file) }
  }
}

const archTextCache = new Map()
let archTextCacheBytes = 0
export async function decompressTextsFor(file, seqs) {
  const want = new Set(seqs)
  let size = 0
  try { size = fs.statSync(file).size } catch {}
  if (size < 8 * 1024 * 1024) return extractSeqTexts(String(readZstd(file) || ''), want)
  const frames = framesFor(file)
  if (frames.length && typeof zstdDecompressFn === 'function') {
    const hits = frames.filter((f) => { for (const s of want) if (s >= f.from && s <= f.to) return true; return false })
    if (hits.length) {
      try {
        const out = new Map()
        const fh = await fs.promises.open(file, 'r')
        try {
          for (const f of hits) {
            const buf = Buffer.allocUnsafe(f.len)
            await fh.read(buf, 0, f.len, f.off)
            const txt = Buffer.from(zstdDecompressFn(buf)).toString('utf8')
            for (const [k, v] of extractSeqTexts(txt, want)) out.set(k, v)
          }
        } finally { try { await fh.close() } catch {} }
        if ([...want].every((s) => out.has(s))) return out
      } catch (e) { console.warn('[log-prune] 按帧读取失败，回落整包：' + (e?.message ?? e)) }
    }
  }
  try {
    const { Worker } = await import('node:worker_threads')
    return await new Promise((resolve, reject) => {
      const w = new Worker(DECOMPRESS_WORKER, { workerData: { file, vendorPath: zstdVendorPath, wantedSeqs: [...want], maxTextBytes: MAX_TEXT_BYTES } })
      const done = (fn, v) => { try { w.terminate() } catch {}; fn(v) }
      const timer = setTimeout(() => done(reject, new Error('worker 解压超时')), 180000)
      w.once('message', (m) => { clearTimeout(timer); m && m.ok ? done(resolve, new Map(m.texts || [])) : done(reject, new Error((m && m.error) || 'worker 取原文失败')) })
      w.once('error', (err) => { clearTimeout(timer); done(reject, err) })
      w.once('exit', (code) => { if (code !== 0) { clearTimeout(timer); done(reject, new Error('worker 退出 ' + code)) } })
    })
  } catch (e) {
    console.warn('[log-prune] worker 取原文失败，回落同步（可能卡顿）：' + (e?.message ?? e))
    return extractSeqTexts(String(readZstd(file) || ''), want)
  }
}

export async function readArchiveTexts(file, wantedSet) {
  const wanted = [...wantedSet]
  let mtimeMs = -1
  try { mtimeMs = fs.statSync(file).mtimeMs } catch {}
  let entry = archTextCache.get(file)
  if (!entry || entry.mtimeMs !== mtimeMs) { entry = { mtimeMs, map: new Map(), probed: new Set(), bytes: 0 }; archTextCache.set(file, entry) }
  const missing = wanted.filter((s) => !entry.probed.has(s))
  if (missing.length) {
    const got = await decompressTextsFor(file, missing)
    for (const s of missing) entry.probed.add(s)
    for (const [k, v] of got) {
      // F11：覆盖同一 seq 时先减旧值，否则记账只增不减，会过早逐出甚至变成负数
      const old = entry.map.get(k)
      if (old != null) { entry.bytes -= (old || '').length; archTextCacheBytes -= (old || '').length }
      entry.map.set(k, v)
      entry.bytes += (v || '').length
      archTextCacheBytes += (v || '').length
    }
  }
  while (archTextCacheBytes > MAX_CACHE_BYTES && archTextCache.size > 1) {
    // F11：最旧的是正在读的文件就选下一个，不再 break（大会话文件曾能无限占住缓存）
    let victim = null
    for (const k of archTextCache.keys()) { if (k !== file) { victim = k; break } }
    if (victim === null) break
    const v = archTextCache.get(victim)
    archTextCacheBytes -= (v && v.bytes) || 0
    archTextCache.delete(victim)
  }
  // 单个文件超过上限一半就不入缓存，而不是“永不逐出自己”
  if (archTextCacheBytes > MAX_CACHE_BYTES && (entry.bytes || 0) > MAX_CACHE_BYTES / 2) {
    archTextCacheBytes -= entry.bytes || 0
    archTextCache.delete(file)
  }
  const out = new Map()
  for (const s of wanted) if (entry.map.has(s)) out.set(s, entry.map.get(s))
  return out
}

const cache = new Map()
const fileTextCache = new Map()
let fileTextCacheBytes = 0
function fileTextCacheDrop(k) {
  const v = fileTextCache.get(k)
  if (!v) return
  fileTextCacheBytes -= v.bytes || 0
  fileTextCache.delete(k)
}
function fileTextCached(full) {
  let st
  try { st = fs.statSync(full) } catch { return null }
  const sig = st.size + ':' + st.mtimeMs
  const hit = fileTextCache.get(full)
  if (hit && hit.sig === sig) { fileTextCache.delete(full); fileTextCache.set(full, hit); return hit.map }
  let text
  try { text = readZstd(full) } catch { return null }
  const fm = new Map()
  for (const line of text.split('\n')) {
    if (!line) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    if (typeof e.seq !== 'number' || e.seq < 0) continue
    fm.set(e.seq, { file: full, day: dayOf(e.time) })
  }
  const old = fileTextCache.get(full)
  if (old) fileTextCacheBytes -= old.bytes || 0
  fileTextCache.set(full, { sig, map: fm, bytes: text.length })
  fileTextCacheBytes += text.length
  while ((fileTextCache.size > FILE_CACHE_MAX || fileTextCacheBytes > MAX_CACHE_BYTES) && fileTextCache.size > 0) {
    fileTextCacheDrop(fileTextCache.keys().next().value)
  }
  return fm
}

export function loadArchive(sid, archiveDir = ARCHIVE_DIR, now = Date.now()) {
  const hit = cache.get(sid)
  if (hit && now - hit.at < CACHE_MS) return hit.map
  const map = new Map()
  const coverage = []
  try {
    const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith(sid + '.日志'))
    for (const f of files) {
      const full = path.join(archiveDir, f)
      const rr = seqRangesComplete(full) ? seqRangesFor(full) : null
      if (rr && rr.length) {
        const day = dayFromArchiveName(f)
        for (const r of rr) coverage.push([r[0], r[1], r[2], full, day])
        continue
      }
      const fm = fileTextCached(full)
      if (!fm) continue
      for (const [k, v] of fm) map.set(k, v)
      try { fs.writeFileSync(full + '.seqs.json', JSON.stringify({ ranges: rangesOfMap(fm), complete: true, at: Date.now() })) } catch {}
    }
  } catch { /* 目录不在就当没归档 */ }
  let out = map
  if (coverage.length) out = new ArchiveView(map, new SeqRanges(coverage))
  cache.set(sid, { at: now, map: out })
  return out
}

const sessionLogCache = new Map()
export async function loadSessionLog(sid, home = HOME, now = Date.now()) {
  const hit = sessionLogCache.get(sid)
  if (hit && now - hit.at < 600e3) return hit.map
  const map = new Map()
  let wsDirs = []
  try { wsDirs = fs.readdirSync(path.join(home, 'sessions')) } catch { return map }
  for (const ws of wsDirs) {
    const dir = path.join(home, 'sessions', ws, sid)
    const zst = path.join(dir, sessionFileName(dir))
    const plain = path.join(dir, sessionFileName(dir).replace(/\.zstd$/, ''))
    let payload = null
    try {
      if (fs.existsSync(zst)) payload = await readEntriesAsync(zst)
      else if (fs.existsSync(plain)) payload = { text: fs.readFileSync(plain, 'utf8') }
    } catch { payload = null }
    if (!payload) continue
    const file = fs.existsSync(zst) ? zst : plain
    const rows = payload.entries || (() => {
      const out = []
      for (const line of String(payload.text || '').split('\n')) {
        if (!line) continue
        let e; try { e = JSON.parse(line) } catch { continue }
        if (typeof e.seq !== 'number' || e.seq < 0) continue
        out.push([e.seq, typeof e.time === 'number' ? e.time : Date.now()])
      }
      return out
    })()
    for (const [seq, time] of rows) map.set(seq, { file, day: dayOf(time) })
  }
  sessionLogCache.set(sid, { at: now, map })
  return map
}

const mirrorCache = new Map()
const mirrorFileCache = new Map()
function mirrorFileCached(full) {
  let st
  try { st = fs.statSync(full) } catch { return null }
  const sig = st.size + ':' + st.mtimeMs
  const hit = mirrorFileCache.get(full)
  if (hit && hit.sig === sig) { mirrorFileCache.delete(full); mirrorFileCache.set(full, hit); return hit.map }
  let text
  try { text = full.endsWith('.zst') ? readZstd(full) : fs.readFileSync(full, 'utf8') } catch { return null }
  const fm = new Map()
  for (const line of text.split('\n')) {
    if (!line) continue
    let e; try { e = JSON.parse(line) } catch { continue }
    if (typeof e.seq !== 'number' || e.seq < 0) continue
    if (!fm.has(e.seq)) fm.set(e.seq, { file: full, day: dayOf(e.time), mirror: true })
  }
  mirrorFileCache.set(full, { sig, map: fm })
  while (mirrorFileCache.size > FILE_CACHE_MAX) mirrorFileCache.delete(mirrorFileCache.keys().next().value)
  return fm
}

export function loadMirror(sid, dir = MIRROR_DIR, now = Date.now()) {
  const hit = mirrorCache.get(sid)
  if (hit && now - hit.at < CACHE_MS) return hit.map
  const map = new Map()
  const scan = (d) => {
    let names = []
    try { names = fs.readdirSync(d).filter((f) => f.includes('_' + sid + '.jsonl')) } catch { return }
    for (const f of names) {
      const full = path.join(d, f)
      const fm = mirrorFileCached(full)
      if (!fm) continue
      for (const [k, v] of fm) if (!map.has(k)) map.set(k, v)
    }
  }
  scan(dir)
  scan(path.join(dir, '已封存'))
  mirrorCache.set(sid, { at: now, map })
  return map
}
