// plain.mjs —— 裁切内容「轻索引 + 按需读原文」（2026-11-17）
// 设计：索引只存可检索条目（首句 + 显著词 + hash），并按天写一份明文副本（<day>.txt）；
// 当天裁的内容读明文即可，归档原文由调用方按 file+mtime 缓存、大文件走 worker 解压。
// 任何失败由调用方 catch，不影响裁切。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { getTimeZone } from './tz.mjs'
const ts = (ms) => { try { return new Date(ms).toLocaleString('sv-SE', { timeZone: getTimeZone() }) } catch { return '' } }
export const hash8 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8)
const oneLine = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max)

const STOP = new Set('的 了 是 在 和 与 或 但 而 就 都 也 又 很 太 更 这 那 有 没有 一个 我们 你们 他们 自己 什么 怎么 为什么 可以 需要 应该 不是 还是 如果 因为 所以 然后 现在 今天 昨天 明天 这里 那里 这个 那个 已经 一起 一直 可能 一定 只能 只会 不要 可以 请 您 你 我 他 她 它'.split(' '))

function tokens(s) {
  const out = new Set()
  const text = String(s || '')
  try {
    const seg = new Intl.Segmenter('zh-Hans', { granularity: 'word' })
    for (const x of seg.segment(text)) {
      if (!x.isWordLike) continue
      const w = x.segment.trim().toLowerCase()
      if (!w || w.length < 2 || w.length > 24) continue
      if (STOP.has(w)) continue
      out.add(w)
    }
  } catch {}
  // 英文/数字/路径/错误码：不依赖分词
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_.\/-]{2,}|[0-9]{2,}|\/[A-Za-z0-9_.\/-]{3,}/g)) {
    const w = m[0].toLowerCase()
    if (w.length >= 2 && w.length <= 48) out.add(w)
  }
  return [...out]
}

// 显著词排序：数字/路径/长词/大写开头的权重更高
function keywords(text, max) {
  const toks = tokens(text)
  const score = (w) => (/\d/.test(w) ? 3 : 0) + (w.length >= 4 ? 2 : 0) + (/[A-Z]/.test(w) ? 2 : 0) + (w.includes('/') ? 3 : 0)
  toks.sort((a, b) => score(b) - score(a))
  return toks.slice(0, max || 24).join(' ')
}

// N2：疑似密钥/令牌/密码脱敏 —— 宁可多打码，也不让明文把密钥暴露给 grep。
const SECRET_RES = [
  // O9（2026-11-18）：分隔符必需，避免把 refreshInterval / apiDocumentation 这类驼峰标识符打码；
  // 真实密钥（sk-xxx、access-token-xxx）都带分隔符。
  /\b(sk|pk|api|access|refresh|secret)[-_][a-z0-9]{8,}\b/gi,
  // 裸的 xxx-token-yyyy 形式（refresh-token-abcdefghijkl / access-token-...），上面那条因「token」不足 8 字匹配不到
  /\b(?:access|refresh|secret|api)[-_]?token[-_][a-z0-9]{8,}\b/gi,
  /\bbearer\s+[a-z0-9._\-]{12,}/gi,
  /(api[_-]?key|access[_-]?token|secret[_-]?key|password|passwd|token)\s*[:=]\s*[A-Za-z0-9_.+\-/=]{6,}/gi,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
]
function scrub(s) {
  let out = String(s || '')
  for (const re of SECRET_RES) out = out.replace(re, '[REDACTED]')
  return out
}
// N2：按字符截断并标注，避免单条 tool 结果把明文目录撑爆
function clip(s, maxChars) {
  const str = String(s || '')
  if (!maxChars || maxChars <= 0 || str.length <= maxChars) return str
  return str.slice(0, maxChars) + '……[已截断，日封后可从归档读全文]'
}

export function makeWriter(root) {
  const seen = new Map()
  function loadSeen(sid, dir) {
    const set = new Set()
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!/^\d{8}\.idx$/.test(f)) continue
        for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
          if (!line) continue
          try { const j = JSON.parse(line); if (typeof j.seq === 'number') set.add(j.seq) } catch {}
        }
      }
    } catch {}
    seen.set(sid, set)
    return set
  }
  return function write(sid, dayOf, entries, opts = {}) {
    if (!sid || !entries || !entries.length) return 0
    const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : 20000
    const keepDays = Number.isFinite(opts.keepDays) ? opts.keepDays : 30
    // O1：.idx 独立保留期；0 = 永久（未传时回落 keepDays，兼容旧调用方）
    const idxKeep = opts.idxKeepDays === undefined ? keepDays : Number(opts.idxKeepDays)
    const redact = opts.redact !== false
    const writePlain = opts.plainEnabled !== false // 只关明文副本，.idx 轻索引仍写
    const dir = path.join(root, sid)
    fs.mkdirSync(dir, { recursive: true })
    const set = seen.get(sid) || loadSeen(sid, dir)
    // M6：命中即刷新，保持 LRU 语义（淘汰时删的是最久未用的）
    if (seen.has(sid)) { seen.delete(sid); seen.set(sid, set) }
    const byDay = new Map()
    for (const e of entries) {
      if (typeof e.seq !== 'number' || set.has(e.seq)) continue
      const raw = String(e.text || '')
      if (!raw.trim()) continue
      const text = clip(redact ? scrub(raw) : raw, maxChars) // N2：先脱敏再截断
      const altered = text !== raw ? 1 : 0 // N2：变了就标记，读取端跳过 hash 校验（hash 用原文算）
      const day = dayOf(e.time || Date.now())
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day).push({
        row: {
          seq: e.seq, time: e.time || Date.now(), role: e.role || '?', type: e.type || '',
          h: hash8(raw), arch: String(e.arch || ''), clip: altered,
          head: oneLine(text, 80), kw: keywords(text, 24),
        },
        text,
      })
    }
    let written = 0
    for (const [day, items] of byDay) {
      const rows = items.map((x) => x.row)
      try {
        fs.appendFileSync(path.join(dir, day + '.idx'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
        // B3：明文副本 —— 只留摘要当天裁的内容还没日封，靠它当天就能读全文（读取时优先于归档）。
        // arch 有值的（已日封/中层裁切）不重复写，读归档即可。
        const plainItems = writePlain ? items.filter((x) => !x.row.arch) : []
        if (plainItems.length) {
          try {
            fs.appendFileSync(path.join(dir, day + '.txt'),
              plainItems.map((x) => JSON.stringify({ seq: x.row.seq, time: x.row.time, role: x.row.role, text: x.text })).join('\n') + '\n', 'utf8')
          } catch {}
        }
        for (const r of rows) set.add(r.seq)
        written += rows.length
      } catch {}
      // O1：清理过期索引/明文——.txt 按 keepDays，.idx 按 idxKeepDays（0 = 永久）
      try {
        const now = Date.now()
        for (const f of fs.readdirSync(dir)) {
          const m = /^(\d{8})\.(idx|txt)$/.exec(f)
          if (!m) continue
          const p = path.join(dir, f)
          const limit = m[2] === 'idx' ? idxKeep : keepDays
          if (limit === 0) continue // 0 = 永久保留
          try { if (now - fs.statSync(p).mtimeMs > limit * 86400000) fs.unlinkSync(p) } catch {}
        }
        // 5.3（2026-11-18）：清完过期文件后，空目录也删掉（原来只删文件，目录永远留着）
        try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir) } catch {}
      } catch {}
    }
    // seen 只是去重用的，别让它随会话数无限长
    if (seen.size > 64) { try { seen.delete(seen.keys().next().value) } catch {} }
    return written
  }
}

// 索引读缓存：按目录内所有 .idx 的 size+mtime 做签名，没变就直接返回上次解析结果。
const idxCache = new Map()
export function readIndex(root, sid) {
  const dir = path.join(root, sid)
  let files = []
  try { files = fs.readdirSync(dir).filter((x) => /^\d{8}\.idx$/.test(x)).sort() } catch { return [] }
  let sig = ''
  for (const f of files) {
    try { const st = fs.statSync(path.join(dir, f)); sig += f + ':' + st.size + ':' + st.mtimeMs + '|' } catch {}
  }
  const hit = idxCache.get(dir)
  if (hit && hit.sig === sig) return hit.rows
  const rows = []
  for (const f of files) {
    try {
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        if (!line) continue
        try { rows.push(JSON.parse(line)) } catch {}
      }
    } catch {}
  }
  rows.sort((a, b) => a.seq - b.seq)
  idxCache.set(dir, { sig, rows })
  return rows
}

// O1.4：.txt 近期全文 grep 兜底——索引只存「首句 80 + 关键词 24」，tool/result 类条目
// 首句常是 JSON 头，关键词覆盖弱；明文还在保留期时直接全文搜一遍（有界：最多 8 份 / 每份前 4MB）。
function txtGrep(dir, toks, maxHits) {
  const hits = []
  let files = []
  try {
    files = fs.readdirSync(dir)
      .filter((f) => /^\d{8}\.txt$/.test(f))
      .sort((a, b) => Number(b.slice(0, 8)) - Number(a.slice(0, 8)))   // 新日期优先
      .slice(0, 8)
  } catch { return hits }
  for (const f of files) {
    let raw = ''
    try {
      const fh = fs.openSync(path.join(dir, f), 'r')
      try {
        const buf = Buffer.alloc(4 * 1024 * 1024)
        const n = fs.readSync(fh, buf, 0, buf.length, 0)
        raw = buf.subarray(0, n).toString('utf8')
      } finally { fs.closeSync(fh) }
    } catch { continue }
    for (const line of raw.split('\n')) {
      if (!line) continue
      const low = line.toLowerCase()
      if (!toks.every((t) => low.includes(t))) continue
      try {
        const j = JSON.parse(line)
        if (typeof j.seq !== 'number') continue
        const text = String(j.text || '')
        const at = text.toLowerCase().indexOf(toks[0])
        const snippet = (at >= 0 ? text.slice(Math.max(0, at - 20), at + 100) : text.slice(0, 100)).replace(/\s+/g, ' ')
        hits.push('seq=' + j.seq + ' ' + ts(j.time) + ' ' + (j.role || '?') + '：' + snippet.slice(0, 120) + '（来源：明文副本 ' + f + '）')
        if (hits.length >= maxHits) return hits
      } catch {}
    }
  }
  return hits
}

export function grepIndex(root, sid, keyword, opts = {}) {
  const toks = String(keyword || '').toLowerCase().split(/[\s,，、;；\/]+/).map((s) => s.trim()).filter(Boolean)
  if (!toks.length) return { ok: false, text: '关键词为空' }
  const maxHits = Math.max(1, Math.min(40, opts.maxHits || 12))
  const hay = (r) => ((r.head || '') + ' ' + (r.kw || '')).toLowerCase()
  const rows = readIndex(root, sid).filter((r) => toks.every((t) => hay(r).includes(t)))
  if (rows.length) {
    return {
      ok: true,
      hits: rows.slice(-maxHits).map((r) => 'seq=' + r.seq + ' ' + ts(r.time) + ' ' + r.role + '：' + String(r.head || '').slice(0, 120)),
      count: rows.length,
    }
  }
  // O1.4：索引没命中 → 明文全文兜底（仍在保留期的 .txt）
  const dir = path.join(root, sid)
  const txtHits = txtGrep(dir, toks, maxHits)
  if (txtHits.length) return { ok: true, hits: txtHits, count: txtHits.length, via: 'txt' }
  // O1.3：空手提示如实化——区分「从没裁过 / 索引没这段 / 内容可能更老」，别让 agent 误判「不存在」
  let idxCount = 0
  try { idxCount = fs.readdirSync(dir).filter((f) => /^\d{8}\.idx$/.test(f)).length } catch {}
  let text = '没搜到（这段可能没被裁过，或关键词没命中索引）' +
    (toks.length > 1 ? '；多词查询要求每个词都命中，可减少关键词或换成更具体的词' : '')
  if (!idxCount) text += '；⚠ 该会话目前没有任何 .idx 索引（还没裁过，或索引被清理过）——请直接用门牌上的 seq 区间调 log_prune_read'
  else text += '；若要找的内容比较老，索引可能未覆盖该时段——用门牌 seq 区间直接调 log_prune_read（会走归档直读兜底）'
  return { ok: false, text }
}

function extractText(ev) {
  if (!ev) return ''
  const c = ev.data?.message?.content ?? ev.data?.content ?? ev.content
  if (typeof c === 'string') return c
  // N1：与裁切端 messageText 严格一致 —— 无 text 的 block 保留为空行，否则写/读两端 hash 永远对不上
  if (Array.isArray(c)) return c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n')
  return ''
}

export function extractSeqTexts(text, want) {
  const out = new Map()
  for (const line of String(text || '').split('\n')) {
    if (!line) continue
    const m = /"seq":(\d+)/.exec(line)
    if (!m || !want.has(Number(m[1]))) continue
    try { out.set(Number(m[1]), extractText(JSON.parse(line))) } catch {}
  }
  return out
}

// B2（2026-11-17）：读取改异步 —— 由调用方传 readTextsAsync(file, wantedSet) 返回 Map<seq,text>，
// 大文件解压由调用方下放 worker，主线程不被卡住；小文件仍同步抽（毫秒级）。
// 解析器只回传命中的几条正文，不再把整份归档解成字符串留在主线程。
export async function readText(root, sid, seqFrom, seqTo, readTextsAsync, opts = {}) {
  const from = Number(seqFrom) || 0
  const to = Number.isFinite(Number(seqTo)) && Number(seqTo) > 0 ? Number(seqTo) : Number.MAX_SAFE_INTEGER
  const rows = readIndex(root, sid).filter((r) => r.seq >= from && r.seq <= to)
  if (!rows.length) {
    // O1.2：索引无条目 ≠ 内容不存在——走归档直读兜底（调用方通过 opts.readArchiveRange 提供，
    // 见 §9 index.js 的 log_prune_read）。config 注释承诺的「门牌 seq 区间读归档兜底」从这里开始兑现。
    if (typeof opts.readArchiveRange === 'function') {
      try {
        const fb = await opts.readArchiveRange(from, to)
        if (fb && fb.text) {
          return { ok: true, text: fb.text + '\n（来源：归档直读——该区间没有索引条目；要按关键词找，先 log_prune_search 别的关键词）' }
        }
        if (fb && fb.empty) {
          return { ok: false, text: '该 seq 区间没有索引条目，归档里也没找到对应原文（这段可能没被裁过，或还没日封）' }
        }
      } catch { /* 兜底失败落回原提示 */ }
    }
    return { ok: false, text: '该 seq 区间没有索引条目（这段可能没被裁过，或索引还没建）；可用门牌 seq 区间重试，或等日封后再读' }
  }
  const maxChars = Math.max(1000, Math.min(400000, opts.maxChars || 20000))
  // arch 为空（只留摘要当天裁、还没日封）时：优先按行的日期直接算归档文件名（不读任何归档），
  // 其次才用调用方给的 loadArchiveMap 兜底（sync，可能慢，只在命名对不上时走）。
  let resolved = null
  const resolveArchive = (r) => {
    if (!resolved && typeof opts.loadArchiveMap === 'function') {
      try { resolved = opts.loadArchiveMap(r) || new Map() } catch { resolved = new Map() }
    }
    const hit = resolved && resolved.get(r.seq)
    return hit && hit.file ? hit.file : ''
  }
  // M3：同一行会被问多次文件名，按 seq 记忆，避免反复 existsSync
  const fileMemo = new Map()
  const fileOf = (r) => {
    if (fileMemo.has(r.seq)) return fileMemo.get(r.seq)
    let f = ''
    if (r.arch) f = r.arch
    else if (typeof opts.plainFileFor === 'function') { try { f = opts.plainFileFor(r) || '' } catch { f = '' } }
    if (!f && typeof opts.archiveFileFor === 'function') { try { f = opts.archiveFileFor(r) || '' } catch { f = '' } }
    if (!f) f = resolveArchive(r)
    fileMemo.set(r.seq, f)
    return f
  }
  const isPlain = (f) => String(f || '').endsWith('.txt')
  // M1：兜底也要能走「命名对不上」时的 loadArchiveMap，否則只有 r.arch/命名规则两条路
  const fallbackOf = (r) => {
    if (r.arch) return r.arch
    if (typeof opts.archiveFileFor === 'function') { try { const f = opts.archiveFileFor(r); if (f) return f } catch {} }
    return resolveArchive(r)
  }
  const files = [...new Set(rows.map(fileOf).filter(Boolean))]
  const foundByFile = new Map()
  const readOne = async (file, wanted) => {
    try {
      const found = isPlain(file) && typeof opts.readPlainTexts === 'function'
        ? await opts.readPlainTexts(file, wanted)
        : await readTextsAsync(file, wanted)
      return found instanceof Map ? found : new Map()
    } catch { return new Map() }
  }
  for (const file of files) {
    const wanted = new Set(rows.filter((r) => fileOf(r) === file).map((r) => r.seq))
    foundByFile.set(file, await readOne(file, wanted))
  }
  // N4/N3：明文没命中（被关掉/超限/命名不符）时，按归档文件兜底再读一次
  const missByFile = new Map()
  for (const r of rows) {
    const f = fileOf(r)
    // M1：clip 行在明文里是残本，即使命中也要拉进归档兜底，争取全文
    if ((foundByFile.get(f) || new Map()).has(r.seq) && !r.clip) continue
    const fb = fallbackOf(r)
    if (!fb || fb === f || (foundByFile.get(fb) || new Map()).has(r.seq)) continue
    if (!missByFile.has(fb)) missByFile.set(fb, new Set())
    missByFile.get(fb).add(r.seq)
  }
  // O7（2026-11-18）：同一归档可能既在 files 循环里读过、又在 missByFile 兜底里命中，
  // 整体覆盖会把第一轮已命中的 seq 冲成 undefined（退化成 80 字首句）。合并而不是覆盖。
  for (const [fb, want] of missByFile) {
    const got = await readOne(fb, want)
    foundByFile.set(fb, new Map([...(foundByFile.get(fb) || new Map()), ...got]))
  }
  const out = []
  let total = 0
  for (const r of rows) {
    if (total >= maxChars) { out.push('…（已达返回上限，缩小 seq 区间再读）'); break }
    const head = '--- seq=' + r.seq + ' | ' + ts(r.time) + ' | ' + r.role + ' ---'
    const file = fileOf(r)
    let body = ''
    let fromIndex = false
    let hit = file ? (foundByFile.get(file) || new Map()).get(r.seq) : undefined
    // M1：clip 行明文是残本，若归档兜底已拿到全文则用全文替换
    if (r.clip) {
      const fb = fallbackOf(r)
      if (fb && fb !== file) {
        const full = (foundByFile.get(fb) || new Map()).get(r.seq)
        if (full !== undefined) hit = full
      }
    }
    if (hit === undefined) {
      const fb = fallbackOf(r)
      if (fb && fb !== file) hit = (foundByFile.get(fb) || new Map()).get(r.seq)
    }
    if (hit !== undefined) { body = hit; fromIndex = true }
    else if (file) body = r.head || ''
    else body = r.head ? r.head + '\n（这段还没日封，索引里只有首句；日封后按同一 seq 再读即可）' : ''
    // B4：hash 只对读到正文的条目校验；首句回退不参与；被截断/脱敏的行 hash 用原文算，跳过
    if (fromIndex && r.h && !r.clip && hash8(body) !== r.h) body += '\n（提示：正文 hash 与索引不一致，内容可能被外部重排，请核对）'
    out.push(head + '\n' + body)
    total += head.length + body.length
  }
  return { ok: out.length > 0, text: out.join('\n\n') }
}
