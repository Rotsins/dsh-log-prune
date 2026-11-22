// volume.mjs —— 会话体积分析（O5，2026-11-20）：只读不改。
// 读一份会话文件，按「stream / 正文 / 门牌与占位 / 系统提示 / 元数据」拆字节占比，
// 顺手给出「置空可省多少」。给 F2 分级放量当抓手：先看清再决定清不清。
import fs from 'node:fs'
import path from 'node:path'
import { readZstd } from './archive.mjs'
import { sessionFileName } from './session-file.mjs'
import { isPlaceholder, isLongText } from './plate.mjs'
import { resolveHome } from './home.mjs'

const HOME = resolveHome()

export function findSessionFileAny(sid) {
  try {
    for (const ws of fs.readdirSync(path.join(HOME, 'sessions'))) {
      const dir = path.join(HOME, 'sessions', ws, sid)
      const f = path.join(dir, sessionFileName(dir))
      try { if (fs.statSync(f).isFile()) return f } catch {}
      try {
        for (const g of fs.readdirSync(dir)) {
          if (/^session\.v\d+\.jsonl$/.test(g)) return path.join(dir, g)
        }
      } catch {}
    }
  } catch {}
  return null
}

// 事件分类：门牌/占位、长文指针、系统提示、正文（user/assistant/tool 的 text）、其余元数据
function classify(ev) {
  if (ev.type === 'system/message') return 'system'
  if (ev.type === 'compaction/prune' || ev.type === 'compaction/end') return 'meta'
  const m = { content: ev.data?.message?.content ?? ev.data?.content ?? [] }
  if (isPlaceholder(m) || isLongText(m)) return 'plate'
  return 'content'
}

export async function analyzeSessionVolume(sid) {
  const file = findSessionFileAny(sid)
  if (!file) return { ok: false, error: '找不到会话文件：' + sid }
  let st = null
  try { st = fs.statSync(file) } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
  let raw = ''
  try {
    raw = file.endsWith('.jsonl') ? fs.readFileSync(file, 'utf8') : String(readZstd(file) || '')
  } catch (e) { return { ok: false, error: '解压失败：' + String(e?.message ?? e) } }
  const lines = raw.split('\n').filter(Boolean)
  // 解压后总字节：stream/content 等分项都按解压字节统计，占比必须用它做分母
  const totalBytes = lines.reduce((a, l) => a + Buffer.byteLength(l), 0)
  const out = {
    ok: true, sid, file, sizeBytes: st.size, totalBytes, lines: lines.length,
    streamBytes: 0, contentBytes: 0, plateBytes: 0, systemBytes: 0, metaBytes: 0, otherBytes: 0,
    assistantWithStream: 0, events: 0, top: [],
  }
  const streamableBytes = { stream: 0, content: 0, plate: 0, system: 0, meta: 0, other: 0 }
  for (const line of lines) {
    let ev
    try { ev = JSON.parse(line) } catch { out.otherBytes += Buffer.byteLength(line); continue }
    if (typeof ev.seq !== 'number') { out.otherBytes += Buffer.byteLength(line); continue }
    out.events++
    const full = Buffer.byteLength(line)
    const kind = classify(ev)
    // stream 字节估算：整行 vs 去掉 stream 后的整行（JSON 键序重排带来的误差 < 1%，可接受）
    let streamPart = 0
    if (ev.type === 'assistant/message' && ev.data && Array.isArray(ev.data.stream) && ev.data.stream.length > 0) {
      out.assistantWithStream++
      try {
        const bare = { ...ev, data: { ...ev.data } }
        delete bare.data.stream
        streamPart = Math.max(0, full - Buffer.byteLength(JSON.stringify(bare)))
      } catch { streamPart = 0 }
    }
    out.streamBytes += streamPart
    streamableBytes.stream += streamPart
    const rest = full - streamPart
    out[kind === 'content' ? 'contentBytes' : kind === 'plate' ? 'plateBytes' : kind === 'system' ? 'systemBytes' : 'metaBytes'] += rest
    streamableBytes[kind] += rest
    if (rest > 512 * 1024) out.top.push({ seq: ev.seq, type: ev.type, kind, bytes: rest })
  }
  out.top.sort((a, b) => b.bytes - a.bytes)
  out.top = out.top.slice(0, 5)
  // 「置空可省」：emptyableBytes 是解压后的 stream 字节（上限）；emptyableCompressedBytes 按文件压缩比折算，
  // 更接近实际能省出的磁盘（zstd 压缩率高，解压字节会明显大于落盘节省，别拿它当磁盘数字）。
  out.emptyableBytes = out.streamBytes
  out.emptyableCompressedBytes = totalBytes ? Math.round(out.sizeBytes * (out.streamBytes / totalBytes)) : 0
  out.emptyableRatio = totalBytes ? Math.round((out.streamBytes / totalBytes) * 100) : 0
  return out
}
