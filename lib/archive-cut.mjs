// archive-cut.mjs —— 离线写回裁切（B2 修复版，2026-11-20）
// 用途：停服/离线时把「门牌 + 摘要」写回会话日志，真正删掉旧消息事件（文件缩小）。
// 注意：会话开着时不要用（DSH 内存里是旧副本，重启/回写会覆盖，11-17 事故）——
//       executeArchiveCut 现在自带 60 秒活跃保护，确要强跑传 force（后果自负）。
// 热路径（只留摘要）仍用 index.js 里的 session.append（不删旧消息，安全）。

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { sessionFileName } from './session-file.mjs'
import { resolveHome } from './home.mjs'

const HOME = resolveHome()
const SESS = path.join(HOME, 'sessions')

let fzstd = null
try { fzstd = (await import(path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor', 'fzstd.mjs'))).decompress } catch {}

// B2：读会话不再只依赖系统 zstd CLI（Windows 没有 CLI 时整条离线路径不可用）。
// 顺序 fzstd → CLI；绝不落 zlib——这是「读全再重写」的路径，只解第一帧 = 静默丢事件。
export function readSessionRowsFiltered(file) {
  let text = ''
  if (fzstd) { try { text = Buffer.from(fzstd(new Uint8Array(fs.readFileSync(file)))).toString('utf8') } catch {} }
  if (!text) {
    try { text = execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 1 << 30, windowsHide: true }) } catch {}
  }
  if (!text) throw new Error('没有可用的多帧安全 zstd 解压（需要插件 vendor/fzstd.mjs 或系统 zstd 命令行）')
  const rows = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
  }
  return rows
}

// B2：写回前的能力闸——Node < 22.15 没有 zstdCompressSync，原代码会直接 TypeError
export function writeArchiveCutFile(file, records) {
  if (typeof zlib.zstdCompressSync !== 'function') {
    throw new Error('当前 Node 缺少 zstdCompressSync（需要 22.15+），离线裁切不能安全写回')
  }
  const frames = []
  for (const r of records) {
    frames.push(zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n')))
  }
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  fs.writeFileSync(tmp, Buffer.concat(frames))
  fs.renameSync(tmp, file)
}

function findSessionFile(sid) {
  const root = SESS
  let entries = []
  try { entries = fs.readdirSync(root) } catch { return null }
  for (const ws of entries) {
    const dir = path.join(root, ws, String(sid))
    const cand = path.join(dir, sessionFileName(dir))
    try { if (fs.statSync(cand).isFile()) return cand } catch {}
    // B10：明文会话兜底（低版本/异常回落出的 session.v<N>.jsonl）
    try {
      for (const f of fs.readdirSync(dir)) {
        if (/^session\.v\d+\.jsonl$/.test(f)) return path.join(dir, f)
      }
    } catch {}
  }
  return null
}

/**
 * 离线写回：保留「非 shadow 区间」的事件 + 新门牌 + 摘要。
 * plan: { cutStart: {seq}, cutEnd: {seq}, shadowSeqs: [..] }
 * summary: { text }
 * force: 会话 60 秒内有写入时默认拒绝；确要强跑传 force（DSH 若开着，内存旧副本会覆盖写回结果）
 */
export async function executeArchiveCut({ sid, plan, summary, log, force = false }) {
  const file = findSessionFile(sid)
  if (!file) return { ok: false, code: 'session-not-found' }
  // B2：活跃保护——文件 60 秒内被写过说明 DSH 可能开着，写回会被内存旧副本覆盖
  try {
    const st = fs.statSync(file)
    if (!force && Date.now() - st.mtimeMs < 60000) {
      return { ok: false, code: 'session-active', detail: '会话文件 60 秒内有写入（可能正被 DSH 打开）；先停服再跑，或明确传 force' }
    }
  } catch (e) { return { ok: false, code: 'stat-failed', detail: String(e?.message ?? e) } }
  let rows
  try { rows = readSessionRowsFiltered(file) } catch (e) { return { ok: false, code: 'decompress-failed', detail: String(e?.message ?? e) } }
  const head = rows.find((r) => r && r.type === 'session')
  if (!head) return { ok: false, code: 'no-head' }
  const start = Number(plan?.cutStart?.seq)
  const end = Number(plan?.cutEnd?.seq)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return { ok: false, code: 'bad-range' }
  const shadowSet = new Set((plan.shadowSeqs || []).map(Number).filter(Number.isFinite))
  // 保留：会话头 + 不在 shadow 区间的事件（新消息 keep）
  const keep = rows.filter((r) => {
    if (!r || !Number.isFinite(r.seq)) return r && r.type !== 'session' ? false : !!r
    if (r.type === 'session') return true
    if (r.seq >= start && r.seq <= end) return false
    return true
  })
  const maxSeq = Math.max(
    end,
    ...keep.map((r) => (Number.isFinite(r.seq) ? r.seq : -1)).filter((x) => x >= 0),
  )
  const door = {
    type: 'compaction/prune',
    seq: maxSeq + 1,
    time: Date.now(),
    // 存储形状与热路径对齐：sourceEventSeqs 在热路径写在 user/message 事件顶层（ev.sourceEventSeqs），不进 data
    data: {
      shadowedRange: { start, end },
      shadowedSeqs: [...shadowSet],
      shadowedTokenCount: Number(plan?.shadowedTokenCount || 0),
    },
  }
  // B2（高危修复）：user/message 的 data 必须带 id——DSH seed 校验「核心只校验 id」，
  // 缺 id 要么会话打不开、要么被 repair-session 当坏事件删掉。形状照抄 offlineAgent 写回路径：
  // data = 消息对象 { id, role, content, source }。
  const sum = {
    type: 'user/message',
    seq: maxSeq + 2,
    time: Date.now(),
    data: {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: String(summary?.text || '') }],
      source: { kind: 'user', rpcId: 'archive-cut-' + Date.now() },
    },
  }
  // 写回前备份：rename 是整份覆盖。备份失败必须中止（O1：不能静默跳过安全网）
  const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 15)
  const bak = file + '.bak-cut-' + ts
  try { fs.copyFileSync(file, bak) } catch (e) {
    return { ok: false, error: '写回前备份失败，已中止（未修改文件）：' + String(e?.message ?? e) }
  }
  writeArchiveCutFile(file, [...keep, door, sum])
  try { log && log('archive-cut 写回完成：保留 ' + keep.length + ' 条，删 ' + (rows.length - keep.length) + ' 条，备份 ' + file + '.bak-cut-' + ts) } catch {}
  return { ok: true, file, kept: keep.length, removed: rows.length - keep.length, door, sum, backup: file + '.bak-cut-' + ts }
}
