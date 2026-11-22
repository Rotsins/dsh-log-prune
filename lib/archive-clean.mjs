// archive-clean.mjs —— 清理旧归档里的 data.stream + 会话 stream 置空（F2 复活版，2026-11-20）
// 归档是 zstd 帧拼接：读 frames.jsonl → 逐帧解压 → 剥 assistant/message.data.stream → 重新压缩写回。
// 会话路径只允许 stream: []（保留字段、置空数组）——DSH 0.2.2 seed 校验要求 assistant/message.data.stream
// 是数组，delete 会让会话载入即报 corrupt（2026-11-19 事故）。默认 off；开 empty 前必须先通过动态验证。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, execFile, spawnSync } from 'node:child_process'
import { canSystemd, systemdUserMode, systemdRunRaw, windowsRestartParts } from './procctl.mjs'
import { unzstd as safeUnzstd, compressZstd as safeCompress } from './zstd-safe.mjs'
const MAX_DECOMP = Math.max(1, Number(process.env.DSH_ARCHIVE_MAX_TEXT_MB) || 512) * 1024 * 1024
import zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ARCHIVE_DIR } from './archive.mjs'
import { resolveHome } from './home.mjs'
import { sessionFileName } from './session-file.mjs'

const HOME = resolveHome()
// 2026-11-19 Windows：补归档脚本优先 DSH_HOME/bin，其次插件自带 bin（tgz 里带了）
const SCRIPT = (() => {
  const cands = [
    process.env.DSH_ARCHIVE_SCRIPT,
    path.join(HOME, 'bin', 'archive-sessions.mjs'),
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'archive-sessions.mjs'),
  ].filter(Boolean)
  return cands.find((p) => fs.existsSync(p)) || cands[1]
})()
// F2：fzstd 的加载统一在 zstd-safe 里（file:// URL，Windows 可用），这里不再各写一份
const SESS = process.env.DSH_SESSIONS_ROOT || path.join(HOME, 'sessions')

// B8：归档文件名通用解析——<YYYYMMDD>_<sid>.日志，sid 不再写死 session- 前缀
const ARCHIVE_NAME_RE = /^(\d{8})_(.+)\.日志$/
function sidOfArchiveName(name) {
  const m = ARCHIVE_NAME_RE.exec(String(name || ''))
  return m ? m[2] : ''
}

// —— B3：解压统一 fzstd → 系统 zstd CLI；内置 zlib 只解第一帧还当成功（archive.mjs 注释原话），
// 「读全再重写」的路径一律 allowZlib=false——读错半份比读不出来更危险。
function zstd(buf) { return safeCompress(buf) }
// S1：统一走 zstd-safe（读改写 allowZlib=false）
function unzstd(buf, { allowZlib = false } = {}) { return safeUnzstd(buf, { allowZlib }) }
function framesOf(file) {
  const side = file + '.frames.jsonl'
  const out = []
  try {
    for (const line of fs.readFileSync(side, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line)) } catch {}
    }
  } catch {}
  return out
}

// B10：会话文件定位同时认 session.v<N>.jsonl.zstd 与明文 session.v<N>.jsonl（低版本/异常回落）
function anySessionFile(dir) {
  try { const f = path.join(dir, sessionFileName(dir)); if (fs.existsSync(f)) return f } catch {}
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^session\.v\d+\.jsonl$/.test(f)) return path.join(dir, f)
    }
  } catch {}
  return null
}
function sessionFileOf(sid) {
  try {
    for (const ws of fs.readdirSync(SESS)) {
      const dir = path.join(SESS, ws, sid)
      const f = anySessionFile(dir)
      if (f) return f
    }
  } catch {}
  return null
}
// 读会话原文：明文直接读；zstd 走多帧安全解压（禁 zlib）
function readSessionRaw(file) {
  if (file.endsWith('.jsonl')) return fs.readFileSync(file)
  return unzstd(fs.readFileSync(file), { allowZlib: false })
}
function readRange(file) {
  try {
    const r = readSessionRaw(file)
    let min = Infinity, max = -1
    for (const line of r.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      try { const e = JSON.parse(line); if (typeof e.seq === 'number' && e.seq >= 0) { if (e.seq < min) min = e.seq; if (e.seq > max) max = e.seq } } catch {}
    }
    return max >= 0 ? { min, max } : null
  } catch { return null }
}
function archivedRanges(sid, dir) {
  const ranges = []
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('_' + sid + '.日志.seqs.json')) continue
      try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); for (const r of j.ranges || []) if (Array.isArray(r) && r.length >= 2) ranges.push([Number(r[0]), Number(r[1])]) } catch {}
    }
  } catch {}
  ranges.sort((a, b) => a[0] - b[0])
  return ranges
}
function gapsIn(range, ranges) {
  const merged = []
  for (const [s, e] of ranges) { const last = merged[merged.length - 1]; if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e); else merged.push([s, e]) }
  const gaps = []
  const lastEnd = merged.length ? merged[merged.length - 1][1] : -Infinity
  let cur = range.min
  for (const [s, e] of merged) {
    if (e < cur) continue
    if (s > cur) gaps.push({ from: cur, to: s - 1 })
    cur = Math.max(cur, e + 1)
    if (cur > range.max) break
  }
  // 尾部超出归档末端的 gap 是「还没归档的新消息」，不是历史洞，不报
  return gaps.filter((g) => g.from <= lastEnd)
}

// B9：只剥「非空数组」的 stream——stream: [] 是 F2 置空后的合法形态，别再删成 undefined
function cleanEvent(e) {
  if (!e || e.type !== 'assistant/message') return e
  const d = e.data
  if (!d || !Array.isArray(d.stream) || d.stream.length === 0) return e
  const c = { ...e, data: { ...d } }
  delete c.data.stream
  return c
}

// 2026-11-19：握手重启请求——写 state/restart-request.json。
// B5：spawn 不代表成功（ENOENT 走 error 事件接不到），Linux 先用 spawnSync 探测 systemd、
// 再用 spawnSync 拿 systemd-run 的真实结果；失败落回握手文件，不误报。
// F6 方案 A：Windows 不再只写握手文件——配了 DSH_RESTART_CMD 就排一次性 schtasks。
const SYSTEMD_UNIT = process.env.DSH_SYSTEMD_UNIT || 'dsh.service'
function writeHandshake(reason) {
  const file = path.join(HOME, 'state', 'restart-request.json')
  fs.writeFileSync(file, JSON.stringify({ version: 1, action: 'restart-dsh', at: Date.now(), reason, graceMs: 5000, requester: 'log-prune' }))
  return file
}
function requestRestartWin(reason) {
  const file = writeHandshake(reason)
  const cmd = process.env.DSH_RESTART_CMD || ''
  if (!cmd) return { ok: true, mode: 'handshake', request: file, note: '未配置 DSH_RESTART_CMD：仅写握手文件，需要常驻 bin/restart-watcher.mjs 或桌面壳消费' }
  // B10：bat 放无空格目录（SystemRoot\Temp），避免 /tr 路径含空格被截断；写失败再回退 state
  const parts = windowsRestartParts({ cmd, handshakeFile: file, home: HOME })
  const { sd, hhmm, tn, batBody } = parts
  let bat = parts.preferred
  try {
    fs.writeFileSync(bat, batBody)
  } catch {
    bat = parts.fallback
    fs.writeFileSync(bat, batBody)
  }
  try {
    const st = spawnSync('schtasks', ['/create', '/f', '/tn', tn, '/sc', 'once', '/sd', sd, '/st', hhmm, '/tr', bat], { windowsHide: true, timeout: 15000 })
    if (st.error || st.status !== 0) return { ok: false, error: 'schtasks 失败：' + String((st.error && st.error.message) || st.stderr || st.status) }
    return { ok: true, mode: 'schtasks', task: tn, request: file, at: sd + ' ' + hhmm }
  } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
}
export function requestRestart(reason = 'archive-stream-clean') {
  let file = ''
  try { file = writeHandshake(reason) } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
  if (process.platform === 'linux' && canSystemd()) {
    try {
      // 清完立即重启：0 秒排队，不做「等 5 秒」的静默窗口（那个窗口正是内存副本回写的风险期）
      const user = systemdUserMode(SYSTEMD_UNIT)
      const args = systemdRunRaw({
        unit: 'dsh-restart-' + Date.now(), userMode: user, onActive: 1,
        command: ['systemctl', ...(user ? ['--user'] : []), 'restart', SYSTEMD_UNIT],
      })
      const st = spawnSync('systemd-run', args, { windowsHide: true, timeout: 10000 })
      if (!st.error && st.status === 0) return { ok: true, mode: 'systemd', request: file }
      // systemd-run 没成 → 落回握手文件语义，不误报成功（B5）
    } catch {}
  }
  if (process.platform === 'win32') return requestRestartWin(reason)
  return { ok: true, mode: 'handshake', request: file }
}

export async function cleanArchiveStreams({ dry = true, dir = ARCHIVE_DIR, log, reconcile = true } = {}) {
  const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 15)
  const QUIET_MS = Number(process.env.DSH_CLEAN_QUIET_MS || 60000)
  const stats = { files: 0, cleaned: 0, frames: 0, bytesBefore: 0, bytesAfter: 0, skipped: [], errors: [], gaps: [], filled: [], gapCount: 0 }
  // B6：补档异步化——execFile + 本地串行队列（复用 ensure-archive 的 serial 模式），
  // 不再用 execFileSync 同步阻塞主线程（每日清理时段整个 DSH 被卡住的问题）
  let fillChain = Promise.resolve()
  const fillGap = (sid, g) => {
    const run = () => new Promise((resolve) => {
      execFile(process.env.DSH_NODE || process.execPath,
        [SCRIPT, '--sid', sid, '--from', String(g.from), '--to', String(g.to)],
        { maxBuffer: 1 << 30, timeout: 120000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
        (err) => resolve(!err))
    })
    const p = fillChain.then(run, run)
    fillChain = p.then(() => {}, () => {})
    return p
  }
  // 对账：会话文件里有、归档没覆盖的区间 → dry 只报，真跑先补档再清理
  const unverified = new Set()   // B4：归档存在但没有任何 .seqs.json 的会话——对账闸门对它失效，不清理它的文件
  if (reconcile) {
    const sids = new Set()
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.日志') || f.includes('.bak-')) continue
        const sid = sidOfArchiveName(f)   // B8：不再写死 _session- 前缀
        if (sid) sids.add(sid)
      }
    } catch {}
    for (const sid of sids) {
      const sfile = sessionFileOf(sid)
      if (!sfile) continue
      const range = readRange(sfile)
      if (!range) continue
      const ranges = archivedRanges(sid, dir)
      if (!ranges.length) {
        // B4：没有 .seqs.json 时 gapsIn 会把所有 gap 滤光 → 该会话静默跳过对账直接清理。
        // 现在明确记为「未核实」，先跑一次归档/补档（loadArchive 也会自举写出 .seqs.json）再清理。
        unverified.add(sid)
        stats.skipped.push({ file: sid, why: 'no-seqs-json（对账盲区，先补档/自举索引再清理）' })
        continue
      }
      const gs = gapsIn(range, ranges)
      if (!gs.length) continue
      for (const g of gs) {
        stats.gaps.push({ sid, from: g.from, to: g.to })
        stats.gapCount++
        if (!dry) {
          const ok = await fillGap(sid, g)   // B6：异步串行
          stats.filled.push({ sid, ...g, ok })
        }
      }
    }
  }
  let names = []
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.日志') && !f.includes('.bak-')) }
  catch (e) { return { ok: false, error: String(e?.message ?? e) } }

  for (const name of names) {
    const file = path.join(dir, name)
    const sid = sidOfArchiveName(name)
    if (sid && unverified.has(sid)) { stats.skipped.push({ file: name, why: 'no-seqs-json' }); continue }
    try {
      const st = fs.statSync(file)
      stats.files++
      // 2026-11-19：最近 QUIET_MS 内被写过（裁切补归档/定时归档在追加）就跳过，防止 rename 覆盖新帧
      if (Date.now() - st.mtimeMs < QUIET_MS) { stats.skipped.push({ file: name, why: 'recently-written' }); continue }
      const frames = framesOf(file)
      const hasStreamLine = (raw) => raw.split('\n').some((line) => {
        if (!line.trim()) return false
        try {
          const e = JSON.parse(line)
          return e && e.type === 'assistant/message' && e.data && Array.isArray(e.data.stream) && e.data.stream.length > 0
        } catch { return false }
      })
      if (frames.length) {
        // B1：侧车完整性核对（只 stat，不读整包）
        const covered = frames.reduce((a, f) => a + (f.len || 0), 0)
        let pos = 0, badOff = false
        for (const f of frames) {
          if (!Number.isFinite(f.off) || !Number.isFinite(f.len) || f.off !== pos) { badOff = true; break }
          pos += f.len
        }
        if (covered !== st.size || badOff) {
          stats.errors.push({ file: name, error: 'frames sidecar incomplete（' + covered + '/' + st.size + (badOff ? '，帧偏移不连续' : '') + '），跳过重写防丢尾' })
          stats.skipped.push({ file: name, why: 'frames-sidecar-incomplete' })
          continue
        }
        // E5：逐帧读，只有「真的改了」才进第二遍重写；内存 = 单帧，不再整包
        let changed = false
        const fd = fs.openSync(file, 'r')
        try {
          for (const fr of frames) {
            const buf = Buffer.alloc(fr.len)
            if (fs.readSync(fd, buf, 0, fr.len, fr.off) !== fr.len) throw new Error('短读：帧 ' + fr.off + '+' + fr.len)
            if (hasStreamLine(unzstd(buf, { allowZlib: false }).toString('utf8'))) { changed = true; break }
          }
        } finally { try { fs.closeSync(fd) } catch {} }
        stats.frames += frames.length
        if (changed) stats.cleaned++
        if (!dry && changed) {
          for (const b of [file, file + '.frames.jsonl', file + '.seqs.json']) {
            try { if (fs.existsSync(b)) fs.copyFileSync(b, b + '.bak-stream-' + ts) } catch {}
          }
          const tmp = file + '.tmp-clean-' + Date.now()
          const newFrames = []
          const fd2 = fs.openSync(file, 'r')
          const out = fs.openSync(tmp, 'w')
          let off = 0
          try {
            for (const fr of frames) {
              const buf = Buffer.alloc(fr.len)
              if (fs.readSync(fd2, buf, 0, fr.len, fr.off) !== fr.len) throw new Error('短读：帧 ' + fr.off + '+' + fr.len)
              const raw = unzstd(buf, { allowZlib: false }).toString('utf8')
              const evs = []
              for (const line of raw.split('\n')) { if (!line.trim()) continue; try { evs.push(JSON.parse(line)) } catch {} }
              const cleaned = evs.map(cleanEvent)
              const z = zstd(Buffer.from(cleaned.map((e) => JSON.stringify(e)).join('\n') + '\n'))
              fs.writeSync(out, z)
              newFrames.push({ off, len: z.length, from: fr.from, to: fr.to, n: cleaned.length, at: Date.now() })
              off += z.length
            }
          } finally { try { fs.closeSync(fd2) } catch {}; try { fs.closeSync(out) } catch {} }
          const ranges = newFrames.map((f) => [f.from, f.to, f.n]).sort((a, b) => a[0] - b[0])
          const merged = []
          for (const r of ranges) {
            const last = merged[merged.length - 1]
            if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1])
            else merged.push([r[0], r[1], r[2]])
          }
          const st2 = fs.statSync(file)
          if (st2.mtimeMs !== st.mtimeMs || st2.size !== st.size) {
            try { fs.unlinkSync(tmp) } catch {}
            stats.skipped.push({ file: name, why: 'changed-during-clean' })
            continue
          }
          fs.renameSync(tmp, file)
          fs.writeFileSync(file + '.frames.jsonl', newFrames.map((f) => JSON.stringify(f)).join('\n') + '\n')
          fs.writeFileSync(file + '.seqs.json', JSON.stringify({ ranges: merged, complete: true, at: Date.now() }))
          stats.bytesBefore += st.size
          stats.bytesAfter += fs.statSync(file).size
        } else if (dry) {
          stats.bytesBefore += st.size
        } else {
          stats.bytesAfter += st.size
        }
      } else {
        // 没有帧侧车的旧归档：保留整包路径（一次性，且这类文件通常很小）
        const buf = fs.readFileSync(file)
        const raw = unzstd(buf, { allowZlib: false }).toString('utf8')
        const evs = []
        for (const line of raw.split('\n')) { if (!line.trim()) continue; try { evs.push(JSON.parse(line)) } catch {} }
        const changed = evs.some((e) => e && e.type === 'assistant/message' && e.data && Array.isArray(e.data.stream) && e.data.stream.length > 0)
        stats.frames += Math.ceil(evs.length / 500) || 0
        if (changed) stats.cleaned++
        if (!dry && changed) {
          for (const b of [file, file + '.frames.jsonl', file + '.seqs.json']) {
            try { if (fs.existsSync(b)) fs.copyFileSync(b, b + '.bak-stream-' + ts) } catch {}
          }
          const cleaned = evs.map(cleanEvent)
          const newFrames = []
          const parts = []
          let off = 0
          for (let i = 0; i < cleaned.length; i += 500) {
            const part = cleaned.slice(i, i + 500)
            if (!part.length) continue
            const z = zstd(Buffer.from(part.map((e) => JSON.stringify(e)).join('\n') + '\n'))
            parts.push(z)
            newFrames.push({ off, len: z.length, from: part[0].seq, to: part[part.length - 1].seq, n: part.length, at: Date.now() })
            off += z.length
          }
          const ranges = newFrames.map((f) => [f.from, f.to, f.n]).sort((a, b) => a[0] - b[0])
          const merged = []
          for (const r of ranges) {
            const last = merged[merged.length - 1]
            if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1])
            else merged.push([r[0], r[1], r[2]])
          }
          const tmp = file + '.tmp-clean-' + Date.now()
          fs.writeFileSync(tmp, Buffer.concat(parts))
          const st2 = fs.statSync(file)
          if (st2.mtimeMs !== st.mtimeMs || st2.size !== st.size) {
            try { fs.unlinkSync(tmp) } catch {}
            stats.skipped.push({ file: name, why: 'changed-during-clean' })
            continue
          }
          fs.renameSync(tmp, file)
          fs.writeFileSync(file + '.frames.jsonl', newFrames.map((f) => JSON.stringify(f)).join('\n') + '\n')
          fs.writeFileSync(file + '.seqs.json', JSON.stringify({ ranges: merged, complete: true, at: Date.now() }))
          stats.bytesBefore += st.size
          stats.bytesAfter += fs.statSync(file).size
        } else if (dry) {
          stats.bytesBefore += st.size
        } else {
          stats.bytesAfter += st.size
        }
      }
    } catch (e) {
      stats.errors.push({ file: name, error: String(e?.message ?? e).slice(0, 160) })
    }
  }
  return { ok: true, ...stats, dry }
}
