#!/usr/bin/env node
// rollback-stream-clean.mjs —— 从 .bak-stream-* 恢复被剥坏会话（2026-11-20 止血用）
// ============================================================
// 背景：2026-11-19 11:00 / 23:45 两批 stripSessionStreams 删掉了 assistant/message.data.stream，
//       DSH 0.2.2 载入时报 "stored session ... is corrupt: seed assistant/message at index N
//       has invalid settlement fields"，18 个会话打不开。
//       写回前生成过 .bak-stream-<时间>，原件（含 stream）就在这些备份里。
//
// 本脚本做什么：
//   1) 扫 sessions 下所有 session.vN.jsonl.zstd 与它们的 .bak-stream-* 备份；
//   2) 判定当前文件是否"已被剥过 stream"（assistant/message 有 content 但 stream 缺失）；
//   3) 命中即判定为受损 → 用最早的备份覆盖回去（覆盖前先把当前文件另存 .bad-<时间>）；
//   4) 默认 dry，只列清单；--apply 才动盘。
//
// 用法：
//   node rollback-stream-clean.mjs                       # dry，列出全部候选
//   node rollback-stream-clean.mjs --apply               # 真恢复
//   node rollback-stream-clean.mjs --sid session-xxx --apply
//   node rollback-stream-clean.mjs --sessions-root /path/to/sessions
//   node rollback-stream-clean.mjs --keep-bad            # 恢复后保留 .bad-*（默认也保留）
//
// ⚠ 跑之前先停 DSH（或确认这些会话没有被本进程加载）：DSH 内存里是旧副本，
//    恢复完它再回写就把恢复覆盖了。
// ============================================================
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
const has = (n) => argv.includes(n)
const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
const APPLY = has('--apply')
const ONLY = argOf('--sid')
const SESSIONS_ROOT = path.resolve(argOf('--sessions-root') ||
  path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions'))
const SESSION_FILE_RE = /^session\.v(\d+)\.jsonl\.zstd$/

let fzstd = null
for (const c of [process.env.DSH_FZSTD_MODULE,
                 path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'plugins', 'dsh-log-prune', 'lib', 'vendor', 'fzstd.mjs')]) {
  if (!c) continue
  try { const m = await import('file://' + c); if (typeof m.decompress === 'function') { fzstd = m.decompress; break } } catch {}
}
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function decodeFramesBuiltin(buf) {
  const offs = []
  for (let i = buf.indexOf(MAGIC); i >= 0; i = buf.indexOf(MAGIC, i + 1)) offs.push(i)
  if (!offs.length) throw new Error('没找到 zstd 帧头')
  const parts = []
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length
    parts.push(zlib.zstdDecompressSync(buf.subarray(offs[k], end)))
  }
  return Buffer.concat(parts)
}
function unzstd(buf) {
  if (fzstd) { try { return Buffer.from(fzstd(new Uint8Array(buf))) } catch {} }
  try { return execFileSync('zstd', ['-dc'], { input: buf, maxBuffer: 1 << 30, windowsHide: true }) } catch {}
  if (typeof zlib.zstdDecompressSync === 'function') return decodeFramesBuiltin(buf)
  throw new Error('没有可用的 zstd 解压')
}

// 统计一个会话文件里 assistant/message 的 stream 情况
function shapeOf(file) {
  const raw = fs.readFileSync(file)
  const text = unzstd(raw).toString('utf8')
  let assistant = 0, withStream = 0, emptyStream = 0, nullStream = 0, events = 0, badLines = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let e = null
    try { e = JSON.parse(line) } catch { badLines++; continue }
    events++
    if (e && e.type === 'assistant/message') {
      assistant++
      const s = e.data && e.data.stream
      if (s == null) nullStream++                                   // 字段缺失 = 本次事故的写法（DSH 会拒载）
      else if (Array.isArray(s) && s.length === 0) emptyStream++     // 空数组 = empty 策略的正常产物
      else withStream++
    }
  }
  return { bytes: raw.length, events, assistant, withStream, emptyStream, nullStream, badLines }
}

function listSessions(root) {
  const out = []
  if (!fs.existsSync(root)) return out
  for (const ws of fs.readdirSync(root)) {
    const wsd = path.join(root, ws)
    let st; try { st = fs.statSync(wsd) } catch { continue }
    if (!st.isDirectory()) continue
    for (const sid of fs.readdirSync(wsd)) {
      if (ONLY && sid !== ONLY) continue
      const dir = path.join(wsd, sid)
      let names = []
      try { names = fs.readdirSync(dir) } catch { continue }
      const cur = names.filter((f) => SESSION_FILE_RE.test(f))
        .map((f) => ({ f, v: Number(f.match(SESSION_FILE_RE)[1]) }))
        .sort((a, b) => b.v - a.v)
      if (!cur.length) continue
      const backs = names.filter((f) => f.includes('.bak-stream-')).sort()
      out.push({ sid, ws, dir, file: path.join(dir, cur[0].f), backs })
    }
  }
  return out
}

const sessions = listSessions(SESSIONS_ROOT)
const rows = []
for (const s of sessions) {
  let cur
  try { cur = shapeOf(s.file) } catch (e) { rows.push({ ...s, error: '当前文件解不开：' + e.message }); continue }
  const bakInfo = []
  for (const b of s.backs) {
    try { bakInfo.push({ name: b, shape: shapeOf(path.join(s.dir, b)) }) } catch (e) { bakInfo.push({ name: b, error: String(e.message).slice(0, 80) }) }
  }
  // 判定：当前存在「data.stream 字段缺失」的 assistant 事件，且某个备份里有带内容的 stream → 受损
  // 注意：stream: [] 是 empty 策略的正常产物，不算受损，绝不能被回滚掉（否则清理白做）。
  const good = bakInfo.filter((b) => !b.error && b.shape.withStream > 0)
                     .sort((a, b) => b.name.localeCompare(a.name))   // 取"最近一份已知good"＝损坏前的状态
  const damaged = cur.nullStream > 0 && good.length > 0
  rows.push({ ...s, cur, bakInfo, damaged, restoreFrom: damaged ? good[0] : null })
}

const MB = (n) => (n / 1048576).toFixed(2) + 'MB'
console.log('=== 会话 stream 清理回滚检查（' + (APPLY ? 'APPLY：会动盘' : 'dry：只列清单') + '） ===')
console.log('sessions 根：' + SESSIONS_ROOT)
console.log('扫到会话：' + sessions.length + ' 个')
console.log('')
let restored = 0
for (const r of rows) {
  if (r.error) { console.log('✗ ' + r.sid + '：' + r.error); continue }
  const tag = r.damaged ? '【受损：data.stream 字段缺失，建议恢复】'
    : (r.cur.withStream > 0 ? '【正常：stream 原样保留】'
    : (r.cur.emptyStream > 0 ? '【正常：stream 已置空数组（empty 策略产物，勿回滚）】' : '【无 assistant stream，无需处理】'))
  console.log('· ' + r.sid + ' ' + tag)
  console.log('    当前：事件 ' + r.cur.events + '，assistant ' + r.cur.assistant + '，带内容stream ' + r.cur.withStream +
    '，空数组stream ' + r.cur.emptyStream + '，缺字段stream ' + r.cur.nullStream + '，坏行 ' + r.cur.badLines + '，' + MB(r.cur.bytes))
  for (const b of r.bakInfo) {
    if (b.error) { console.log('    备份 ' + b.name + ' 读不了：' + b.error); continue }
    console.log('    备份 ' + b.name + '：assistant ' + b.shape.assistant + '，带内容stream ' + b.shape.withStream + '，' + MB(b.shape.bytes))
  }
  if (r.damaged && APPLY) {
    const src = path.join(r.dir, r.restoreFrom.name)
    const bad = r.file + '.bad-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
    fs.copyFileSync(r.file, bad)
    const tmp = r.file + '.tmp-rollback-' + Date.now()
    fs.copyFileSync(src, tmp)
    fs.renameSync(tmp, r.file)
    restored++
    console.log('    ✓ 已从 ' + r.restoreFrom.name + ' 恢复；被剥坏的那份留在 ' + path.basename(bad))
  }
}
console.log('')
console.log('汇总：受损候选 ' + rows.filter((r) => r.damaged).length + ' 个' + (APPLY ? '，已恢复 ' + restored + ' 个' : '（dry，未改动）'))
if (!APPLY && rows.some((r) => r.damaged)) console.log('下一步：确认 DSH 已停 → 加 --apply 重跑')
if (APPLY) console.log('恢复后请启动 DSH 逐个打开确认；确认无误再删 .bad-* 与 .bak-stream-*（保留最近一份即可）。')
