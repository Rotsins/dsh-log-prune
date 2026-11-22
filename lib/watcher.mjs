// 摘要轮询：token 到线就用本机 API 给会话排一条「写摘要」任务（从 bin/summary-watcher.mjs 收编）
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { resolveHome } from './home.mjs'
import { sessionFileName } from './session-file.mjs'
import { tryLock, releaseLock } from './lock.mjs'
import { writeJsonAtomic } from './atomic.mjs'
import { ensureArchived } from './ensure-archive.mjs'   // O3：后台预归档
import { scanResidue, eraNeeded, eraInstruction } from './era.mjs'   // O2：时代合并
const HOME = resolveHome()
export const TOK_DIR = process.env.DSH_LOG_PRUNE_TOKDIR || path.join(HOME, 'state', 'prune-tokens')
export const STATE_FILE = process.env.DSH_SUMMARY_STATE || path.join(HOME, 'state', 'summary-requested.json')
// 上弦文件：派发摘要时写，pre-step 收到下一条消息后裁完删
export const ARMED_DIR = process.env.DSH_LOG_PRUNE_ARMEDDIR || path.join(HOME, 'state', 'prune-armed')
const DEFAULT_CLIENT = process.env.DSH_SUMMARY_CLIENT || ''
const DEFAULT_API = process.env.DSH_DISPATCH_API || 'http://127.0.0.1:3099'

const LOG_FILE = path.join(HOME, 'state', 'summary-dispatch.log')
import { tsLocal } from './util.mjs'
const fileLog = (msg) => {
  try {
    fs.appendFileSync(LOG_FILE, tsLocal() + ' ' + msg + '\n')
    // 5.3（2026-11-18）：超过 5MB 滚动一份 .1，防止无限增长（Windows 上 rename 前先 unlink 目标）
    try {
      if (fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
        try { fs.unlinkSync(LOG_FILE + '.1') } catch {}
        try { fs.renameSync(LOG_FILE, LOG_FILE + '.1') } catch {}
      }
    } catch {}
  } catch {}
}

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }

export function instruction({ from, to, 前言 = '' }) {
  return [
    (前言 ? 前言 + '\n' : '') + '【裁切摘要任务】为本会话写一份上下文摘要，作为裁切前的记忆锚点。',
    '要求：',
    '1. 文本第一行必须原样以「【裁切摘要】」开头；第二行写「覆盖：seq ' + from + '-' + to + '」。',
    '2. 正文不超过 3000 字，只写结论、决定、约定、未完成事项、关键路径与命令；不要复述原文。',
    '3. 覆盖区间内若有以「【长文落盘】」开头的消息，在正文里单列一行「长文落盘：」，逐条写路径 + 一句话说明（最多 10 条），让裁切后还能找回原文。',
    '4. 结尾加一行「门牌索引：」，逐行列出覆盖区间内的原文门牌（最多 30 条）。',
    '5. 门牌索引里不得出现摘要自身的门牌，也不要引用旧摘要；摘要只从原文生成。',
    '6. 除了查 token 用的 log_prune_status，不要调用其他工具。',
    // 2026-11-17 删掉旧第 7 条「低于 X token 就回复忽略」：它给了模型一个跳过出口 + 一句现成话术，
    // 实测模型会跳过工具调用直接照抄那句话（测试会话 seq 86611），明明 40 万也判成「低于阈值」。
    // 撤销由插件侧负责：上弦中 token 掉到摘要线一半以下会自动取消上弦，不需要模型自己判断。
    '7. 当前 token 以 log_prune_status 的返回为准，不要自己数上下文。本任务必须产出摘要正文，不要跳过。',
    '8. 摘要正文必须写成普通回复（text），不要只放在思考（reasoning）里——落地检测和裁切只认正文。',
  ].join('\n')
}

// Q16：按路径缓存；改了 summaryClientPath 不用重启就换新的客户端
let client = null
let clientPath = ''
// Q4：Windows 的 C:/... 不能直接交给 import()（会被当裸模块名），先转成 file:// URL
const toSpecifier = (p) => (p.startsWith('file://') ? p : (/^[A-Za-z]:[\\/]|^[\\/]/.test(p) ? pathToFileURL(p).href : p))
async function api(cfg, log) {
  const p = cfg.summaryClientPath || DEFAULT_CLIENT
  if (!p) throw new Error('未配置 summaryClientPath（排队摘要需要能 import 的客户端模块）')
  if (!client || clientPath !== p) {
    const mod = await import(toSpecifier(p))
    client = new mod.NodeApiClient(cfg.summaryApiUrl || DEFAULT_API, 30000, {})
    clientPath = p
  }
  return client
}


export async function tick(cfg, log = () => {}, getConfigFor = null, deliverPrompt = null, probe = null, pruneNow = null, listSessions = null, getSession = null) {
  // 一个进程里可能挂着多份 log-prune，三份都跑 tick 会重复派发：抢到锁的那份干活
  // Q11：一次 tick 可能遍历很多会话 + 网络调用，60 秒太小，容易把还在跑的锁当 stale 清掉
  if (!tryLock('watch', 180000)) return 0
  try {
    return await tickInner(cfg, log, getConfigFor, deliverPrompt, probe, pruneNow, listSessions, getSession)
  } finally {
    releaseLock('watch')
  }
}

// 「探测不到活动 agent」告警去重（每会话 10 分钟最多一行）
const lastMissWarn = new Map()

async function tickInner(cfg, log = () => {}, getConfigFor = null, deliverPrompt = null, probe = null, pruneNow = null, listSessions = null, getSession = null) {
  const now = Date.now()
  const state = readJson(STATE_FILE, {})
  // 候选会话 = 状态文件里的 + 进程里活着的 agent
  // （以前只扫状态文件：文件不更新就永远看不到这些会话，缺陷 2）
  const cands = new Set()
  try { for (const f of fs.readdirSync(TOK_DIR)) if (f.endsWith('.json')) cands.add(f.slice(0, -5)) } catch {}
  if (typeof listSessions === 'function') { try { for (const sid of listSessions()) if (sid) cands.add(sid) } catch {} }
  if (!cands.size) return 0
  let acted = 0
  for (const sid of cands) {
   try { // per-session 兜底：一个会话出错不该让后面的会话本轮全部跳过
    const stPath = path.join(TOK_DIR, sid + '.json')
    let st = readJson(stPath, null)
    // 缺陷 2/3：状态超过 90 秒没更新就主动探测一次；探不到（没有活的 agent）就在长时间静默后记一行
    if (typeof probe === 'function' && (!st || typeof st.at !== 'number' || now - st.at > 90000)) {
      const fresh = probe(sid)
      if (fresh) { st = fresh } else {
        const age = st && typeof st.at === 'number' ? Math.round((now - st.at) / 1000) : -1
        // 静默会话很多，10 分钟一条太吵：同一会话 6 小时最多记一行
        if ((age < 0 || age > 600) && now - (lastMissWarn.get(sid) || 0) > 6 * 3600e3) {
          // Q20：Map 无界会长住已消失的会话；先清 24 小时前的，还太多就整体清空
          if (lastMissWarn.size > 200) {
            const cut = now - 24 * 3600e3
            for (const [k, v] of lastMissWarn) if (v < cut) lastMissWarn.delete(k)
            if (lastMissWarn.size > 500) lastMissWarn.clear()
          }
          lastMissWarn.set(sid, now)
          fileLog('探测不到活动 agent：' + sid.slice(0, 20) + (age < 0 ? '（无状态文件）' : '（状态停在 ' + age + ' 秒前）'))
        }
      }
    }
    if (!st || typeof st.tokens !== 'number') continue
    const eff = typeof getConfigFor === 'function' ? getConfigFor(sid) : cfg
    // 到线就直接裁（不再等 pre-step；裁不动 pre-step 里会照常记原因）
    const hardLine = Math.round(Number(eff.compactPoint || 0) * Number(eff.triggerRatio || 0))
    const pruneLine = hardLine // 强制裁切恒用硬线（55 万）；摘要线只负责派摘要，不许把兜底线拉低
    // 2026-11-17 管理员定：上弦期间摘要一落地就裁（不等下一条消息），由 pruneNow 内部判定。
    try {
      if (typeof pruneNow === 'function' && fs.existsSync(path.join(ARMED_DIR, sid + '.json'))) {
        if (pruneNow(sid)) acted++
      }
    } catch (e) { fileLog('上弦触发失败 ' + sid.slice(0, 20) + '：' + (e?.message ?? e)) }
    // 兜底：没上弦时到线才裁
    // 别再按「摘要后又长出新内容」触发——摘要自身产生的几条记录会被当成新内容，连发摘要/连裁。
    if (typeof pruneNow === 'function' && pruneLine && st.tokens >= pruneLine) {
      try { if (pruneNow(sid)) acted++ } catch (e) { fileLog('触发裁切失败 ' + sid.slice(0, 20) + '：' + (e?.message ?? e)) }
    }
    // —— O2 时代摘要合并：门牌/旧摘要残留达到阈值就派「合并模式」任务（复用上弦落地裁切）——
    // 放在普通摘要闸门之前：门牌堆积的会话 token 可能远低于摘要线，普通闸门永远轮不到它。
    if (eff.eraMerge && typeof deliverPrompt === 'function' && typeof getSession === 'function') {
      try {
        const armedPath = path.join(ARMED_DIR, sid + '.json')
        if (!fs.existsSync(armedPath)) {
          const session = getSession(sid)
          if (session) {
            const residue = scanResidue(session)
            if (residue.firstSeq > 0 && residue.lastSeq > residue.firstSeq && eraNeeded(residue, eff)) {
              const eraKey = sid + ':era'
              const prevEra = state[eraKey]
              const coolOk = !prevEra || now - (prevEra.at || 0) > (eff.summaryCooldownMs || 600000)
              const grew = !prevEra || residue.lastSeq > (prevEra.lastSeq || 0)
              if (coolOk && grew) {
                const ok = deliverPrompt(sid, eraInstruction({ from: residue.firstSeq, to: residue.lastSeq }))
                if (ok) {
                  state[eraKey] = { at: now, lastSeq: residue.lastSeq }
                  writeJsonAtomic(STATE_FILE, state)
                  try {
                    fs.mkdirSync(ARMED_DIR, { recursive: true })
                    writeJsonAtomic(path.join(ARMED_DIR, sid + '.json'), { at: now, era: true, from: residue.firstSeq, to: residue.lastSeq, lastSeqSeen: residue.lastSeq })
                  } catch {}
                  fileLog('时代合并已派发 ' + sid.slice(0, 20) + '（门牌 ' + residue.plates.length + ' / 旧摘要 ' + residue.summaries.length + '，seq ' + residue.firstSeq + '-' + residue.lastSeq + '）')
                  log('已派时代合并：' + sid.slice(0, 20) + '（门牌 ' + residue.plates.length + ' / 旧摘要 ' + residue.summaries.length + '）')
                  acted++
                  continue
                }
              }
            }
          }
        }
      } catch (e) { fileLog('时代合并检查失败 ' + sid.slice(0, 20) + '：' + (e?.message ?? e)) }
    }
    if (!eff.summaryEnabled) continue
    if (st.tokens < eff.summaryPoint) continue
    // 已经上弦还没落地/还没裁：不重复派发
    try { if (fs.existsSync(path.join(ARMED_DIR, sid + '.json'))) continue } catch {}
    const prev = state[sid]
    // 上一次挂的摘要任务还没落地（表面上还没有新摘要）：不重复挂，等它这一份。
    // ⚠ 但记录可能早就过时了（例如表面被压缩过，summarySeq 从 67465 回到 0）：
    // 那种情况下旧判据会永久卡住，摘要再也不派。所以只有「记录还新鲜、且表面没长过」才等。
    const prevFresh = !!prev && typeof prev.at === 'number' && now - prev.at < 2 * 3600e3
    const surfaceGrew = !!prev && (st.lastSeq ?? 0) > (prev.lastSeq ?? 0)
    if (prev && prevFresh && !surfaceGrew && typeof st.summarySeq === 'number' && st.summarySeq <= (prev.summarySeq ?? 0)) {
      fileLog('等上一条摘要落地：' + sid.slice(0, 20) + '（prev.summarySeq=' + (prev.summarySeq ?? 0) + '，表面 summarySeq=' + st.summarySeq + '）')
      continue
    }
    if (prev && now - prev.at < eff.summaryCooldownMs) continue
    // 只有「越过阈值之后又有新内容」才再排一次；
    // 别用 summarySeq 判断——写完摘要后继续聊到 40 万，同样该再排一次
    if (prev && prev.lastSeq && st.lastSeq <= prev.lastSeq) continue
    // 摘要落地本身会产生几条新记录：不足 20 个节点不算「又有新内容」，否则会为一句话再派一次摘要
    if (prev && typeof prev.lastSeq === 'number' && (st.lastSeq ?? 0) - prev.lastSeq < 20) continue
    // from 不能早于当前表面还看得见的第一条：否则摘要要覆盖一大段已被压缩掉的内容
    const fromStart = prev?.lastSeq ? prev.lastSeq + 1 : (st.summarySeq ?? 0) + 1
    const from = Math.max(fromStart, st.firstSeq || 0)
    const to = st.lastSeq ?? 0
    if (!from || !to || to <= from) continue
    fileLog('到线 ' + sid.slice(0, 20) + ' tokens=' + st.tokens + ' seq ' + from + '-' + to)
    try {
      if (deliverPrompt) {
        const ok = deliverPrompt(sid, instruction({ from, to }))
        if (ok) {
          state[sid] = { at: now, lastSeq: to, summarySeq: st.summarySeq ?? 0 }
          writeJsonAtomic(STATE_FILE, state)
          try { fs.mkdirSync(ARMED_DIR, { recursive: true }); writeJsonAtomic(path.join(ARMED_DIR, sid + '.json'), { at: now, from, to }) } catch {}
          fileLog('已排摘要(进程内) ' + sid.slice(0, 20) + ' seq ' + from + '-' + to + '（已上弦）')
          log('已排摘要(进程内)：' + sid.slice(0, 20) + ' seq ' + from + '-' + to + '（tokens=' + st.tokens + '）')
          acted++
          continue
        }
      }
      const c = await api(eff, log) // P5：用会话级有效配置，否则面板上按会话填的 summaryApiUrl/ClientPath 不生效
      await c.call('session/prompt', {
        sessionId: sid,
        content: [{ type: 'text', text: instruction({ from, to }) }],
      })
      state[sid] = { at: now, lastSeq: to, summarySeq: st.summarySeq ?? 0 }
      writeJsonAtomic(STATE_FILE, state)
      try { fs.mkdirSync(ARMED_DIR, { recursive: true }); writeJsonAtomic(path.join(ARMED_DIR, sid + '.json'), { at: now, from, to }) } catch {}
      log('已排摘要：' + sid.slice(0, 20) + ' seq ' + from + '-' + to + '（tokens=' + st.tokens + '，已上弦）')
      acted++
    } catch (e) {
      fileLog('派发失败 ' + sid.slice(0, 20) + '：' + (e?.message ?? e))
      log('摘要派发失败 ' + sid.slice(0, 20) + '：' + (e?.message ?? e))
    }
   } catch (e) { fileLog('会话处理异常 ' + sid.slice(0, 20) + '：' + (e?.message ?? e)) }
  }
  return acted
}

export function startWatcher(ctx, { getConfig, getConfigFor, deliverPrompt, probe, pruneNow, listSessions, log, getSession }) {
  ctx.effect(() => {
    let stopped = false
    let timer = null
    const loop = async () => {
      if (stopped) return
      try { await tick(getConfig(), log, getConfigFor, deliverPrompt, probe, pruneNow, listSessions, getSession) } catch (e) { log('轮询异常：' + (e?.message ?? e)) }
      if (stopped) return
      timer = setTimeout(loop, getConfig().summaryIntervalMs)
    }
    // 上弦快速通道（2026-11-17 管理员定：2 秒）：只在上弦存在时干活，
    // 摘要一落盘就裁，不等 20 秒的主轮询；没有上弦文件时只是一次空目录读，代价可忽略。
    let fastTimer = null
    const armedMtime = new Map()
    // O15（2026-11-18）：路径缓存——findSessionFile 原来每 2 秒对每个上弦会话 readdirSync 整棵
    // sessions 树；会话路径不会变，命中且文件还在就直接用。
    const fileCache = new Map()
    const findSessionFile = (sid) => {
      const hit = fileCache.get(sid)
      if (hit) { try { fs.statSync(hit); return hit } catch { fileCache.delete(sid) } }
      try {
        for (const ws of fs.readdirSync(path.join(HOME, 'sessions'))) {
          const dir = path.join(HOME, 'sessions', ws, sid)
          const f = path.join(dir, sessionFileName(dir))
          try { fs.statSync(f); fileCache.set(sid, f); return f } catch {}
        }
      } catch {}
      return ''
    }
    const fastLoop = () => {
      if (stopped) return
      let nextMs = 2000
      try {
        // P8：目录不存在时不再每 2 秒抛一次异常，退避到 10 秒
        if (!fs.existsSync(ARMED_DIR)) nextMs = 10000
      } catch { nextMs = 10000 }
      try {
        const armedNow = new Set()
        for (const n of fs.readdirSync(ARMED_DIR)) {
          if (!n.endsWith('.json')) continue
          const sid = n.slice(0, -5)
          armedNow.add(sid)
          // 触发源改成「会话文件变了」：摘要落盘会让 mtime 变，2 秒内就能看见。
          // 原来靠 token 状态文件里的 summarySeq，那是 pre-step 才刷新的，实测要等 95 秒。
          let mt = 0
          try { const f = findSessionFile(sid); if (f) mt = fs.statSync(f).mtimeMs } catch {}
          if (!mt) continue
          const last = armedMtime.get(sid) || 0
          if (mt <= last) continue
          armedMtime.set(sid, mt)
          try { if (pruneNow) pruneNow(sid, { force: true }) } catch (e) { log('上弦快速通道失败：' + (e?.message ?? e)) }
        }
        // O15：下弦的会话从 armedMtime 里清掉（原来只增不减）
        for (const k of armedMtime.keys()) if (!armedNow.has(k)) armedMtime.delete(k)
      } catch {}
      if (stopped) return
      fastTimer = setTimeout(fastLoop, nextMs)
    }
    log('watcher 启动（间隔 ' + getConfig().summaryIntervalMs + 'ms，上弦通道 2000ms，摘要客户端 ' + (getConfig().summaryClientPath || '(未配置)') + '）')
    // O3：后台预归档——token 新鲜（120 秒内测过）且 ≥ summaryPoint × preArchiveRatio 的会话，
    // 提前跑一次 ensureArchived（已覆盖时它是纯内存判断，几乎零开销；失败自带 5 分钟冷却）。
    // 每轮最多补 2 个会话，防止归档脚本风暴。
    let preTimer = null
    const preLoop = async () => {
      if (stopped) return
      try {
        const base = getConfig()
        if (base.preArchive !== false) {
          const now0 = Date.now()
          const cands = []
          try {
            for (const f of fs.readdirSync(TOK_DIR)) {
              if (!f.endsWith('.json')) continue
              try {
                const j = JSON.parse(fs.readFileSync(path.join(TOK_DIR, f), 'utf8'))
                if (j && typeof j.tokens === 'number' && typeof j.at === 'number' && now0 - j.at < 120e3) {
                  cands.push({ sid: f.slice(0, -5), tokens: j.tokens, lastSeq: Number(j.lastSeq) || 0 })
                }
              } catch {}
            }
          } catch {}
          cands.sort((a, b) => b.tokens - a.tokens)
          let budget = 2
          for (const c of cands) {
            if (budget <= 0) break
            const eff = typeof getConfigFor === 'function' ? getConfigFor(c.sid) : base
            const line = Number(eff.summaryPoint || 0) * Number(eff.preArchiveRatio || 0.6)
            if (!line || !c.lastSeq || c.tokens < line) continue
            try { await ensureArchived(c.sid, c.lastSeq, { log }); budget-- } catch {}
          }
        }
      } catch {}
      if (stopped) return
      preTimer = setTimeout(preLoop, 60000)
    }
    preTimer = setTimeout(preLoop, 15000)
    timer = setTimeout(loop, 5000)
    fastTimer = setTimeout(fastLoop, 3000)
    return () => { stopped = true; if (timer) clearTimeout(timer); if (fastTimer) clearTimeout(fastTimer); if (preTimer) clearTimeout(preTimer) }
  })
}
