// 摘要轮询：token 到线就用本机 API 给会话排一条「写摘要」任务（从 bin/summary-watcher.mjs 收编）
import fs from 'node:fs'
import path from 'node:path'

import { resolveHome } from './home.mjs'
const HOME = resolveHome()
export const TOK_DIR = process.env.DSH_LOG_PRUNE_TOKDIR || HOME + '/state/prune-tokens'
export const STATE_FILE = process.env.DSH_SUMMARY_STATE || HOME + '/state/summary-requested.json'
const DEFAULT_CLIENT = process.env.DSH_SUMMARY_CLIENT || ''
const DEFAULT_API = process.env.DSH_DISPATCH_API || 'http://127.0.0.1:3099'

const LOG_FILE = HOME + '/state/summary-dispatch.log'
const fileLog = (msg) => { try { fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + msg + '\n') } catch {} }

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
    '6. 只输出摘要文本，不要调用工具。',
  ].join('\n')
}

let client = null
async function api(cfg, log) {
  const p = cfg.summaryClientPath || DEFAULT_CLIENT
  if (!p) throw new Error('未配置 summaryClientPath（排队摘要需要能 import 的客户端模块）')
  if (!client) {
    const mod = await import(p)
    client = new mod.NodeApiClient(cfg.summaryApiUrl || DEFAULT_API, 30000, {})
  }
  return client
}


export async function tick(cfg, log = () => {}, getConfigFor = null, deliverPrompt = null) {
  if (!fs.existsSync(TOK_DIR)) return 0
  const state = readJson(STATE_FILE, {})
  const now = Date.now()
  let acted = 0
  for (const f of fs.readdirSync(TOK_DIR)) {
    if (!f.endsWith('.json')) continue
    const sid = f.slice(0, -5)
    const st = readJson(path.join(TOK_DIR, f), null)
    if (!st || typeof st.tokens !== 'number') continue
    const eff = typeof getConfigFor === 'function' ? getConfigFor(sid) : cfg
    if (!eff.summaryEnabled) continue
    if (st.tokens < eff.summaryPoint) continue
    fileLog('到线 ' + sid.slice(0, 20) + ' tokens=' + st.tokens + ' lastSeq=' + st.lastSeq)
    const prev = state[sid]
    if (prev && now - prev.at < eff.summaryCooldownMs) continue
    // 只有「越过阈值之后又有新内容」才再排一次；
    // 别用 summarySeq 判断——写完摘要后继续聊到 40 万，同样该再排一次
    if (prev && prev.lastSeq && st.lastSeq <= prev.lastSeq) continue
    const from = prev?.lastSeq ? prev.lastSeq + 1 : (st.summarySeq ?? 0) + 1
    const to = st.lastSeq ?? 0
    if (!from || !to || to <= from) continue
    try {
      if (deliverPrompt) {
        const ok = deliverPrompt(sid, instruction({ from, to }))
        if (ok) {
          state[sid] = { at: now, lastSeq: to, summarySeq: st.summarySeq ?? 0 }
          fs.writeFileSync(STATE_FILE, JSON.stringify(state))
          fileLog('已排摘要(进程内) ' + sid.slice(0, 20) + ' seq ' + from + '-' + to)
          log('已排摘要(进程内)：' + sid.slice(0, 20) + ' seq ' + from + '-' + to + '（tokens=' + st.tokens + '）')
          acted++
          continue
        }
      }
      const c = await api(cfg, log)
      await c.call('session/prompt', {
        sessionId: sid,
        content: [{ type: 'text', text: instruction({ from, to }) }],
      })
      state[sid] = { at: now, lastSeq: to, summarySeq: st.summarySeq ?? 0 }
      fs.writeFileSync(STATE_FILE, JSON.stringify(state))
      log('已排摘要：' + sid.slice(0, 20) + ' seq ' + from + '-' + to + '（tokens=' + st.tokens + '）')
      acted++
    } catch (e) {
      fileLog('派发失败 ' + sid.slice(0, 20) + '：' + (e?.message ?? e))
      log('摘要派发失败 ' + sid.slice(0, 20) + '：' + (e?.message ?? e))
    }
  }
  return acted
}

export function startWatcher(ctx, { getConfig, getConfigFor, deliverPrompt, log }) {
  ctx.effect(() => {
    let stopped = false
    let timer = null
    const loop = async () => {
      if (stopped) return
      try { await tick(getConfig(), log, getConfigFor, deliverPrompt) } catch (e) { log('轮询异常：' + (e?.message ?? e)) }
      if (stopped) return
      timer = setTimeout(loop, getConfig().summaryIntervalMs)
    }
    log('watcher 启动（间隔 ' + getConfig().summaryIntervalMs + 'ms，摘要客户端 ' + (getConfig().summaryClientPath || '(未配置)') + '）')
    timer = setTimeout(loop, 5000)
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  })
}
