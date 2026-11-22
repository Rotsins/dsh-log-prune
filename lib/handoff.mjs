// 交接：把裁掉的一段交给别的插件（默认关）
// 产物：<handoffDir>/<sid>-<from>-<to>.json（清单，含文本与门牌线索）+ 事件 log-prune/pruned
//
// O7（2026-11-20）：清单 schema 冻结 v1。要接记忆/日记插件，就把这份清单当协议用——
// 字段名与语义见 HANDOFF_SCHEMA_FIELDS；后续版本只允许「追加新字段」，不允许改名/改义/删除。
import fs from 'node:fs'
import path from 'node:path'
import { resolveHome } from './home.mjs'

export const HANDOFF_SCHEMA = 'dsh-log-prune.handoff/v1'

// v1 字段契约（消费方按这份表解析；extra 字段忽略即可）：
//   schema    string  固定 'dsh-log-prune.handoff/v1'
//   v         number  固定 1
//   at        string  ISO 时间（交接发生时刻）
//   sessionId string  完整会话 id（session-<uuid>）
//   fromSeq   number  被裁区间起点（含）
//   toSeq     number  被裁区间终点（含）
//   seqs      number[]被裁表面节点的 seq 列表（表面顺序，可含替换节点）
//   plates    string[]区间内旧门牌节点的 seq（字符串形式，兼容旧消费方）
//   text      string  被裁内容的拼接正文（≤400000 字符，已按表面顺序拼接）
//   file      string? 清单落盘路径（事件里带；清单文件本身没有这个字段）
export const HANDOFF_SCHEMA_FIELDS = ['schema', 'v', 'at', 'sessionId', 'fromSeq', 'toSeq', 'seqs', 'plates', 'text']

export function handoffDir(cfg) {
  return cfg.handoffDir || path.join(resolveHome(), 'state/pruned-outbox')
}

export function deliver(ctx, log, cfg, { sid, from, to, seqs, text, plates = [] }) {
  if (!cfg.handoffEnabled) return null
  // v1 形状校验：字段不完整的清单对消费方是毒药，宁可不发
  const fromN = Number(from), toN = Number(to)
  if (!sid || !Number.isFinite(fromN) || !Number.isFinite(toN) || !Array.isArray(seqs)) {
    log('交接清单字段不完整（v1 需要 sid/fromSeq/toSeq/seqs），跳过本次交接')
    return null
  }
  const payload = {
    schema: HANDOFF_SCHEMA,
    v: 1,
    at: new Date().toISOString(),
    sessionId: String(sid),
    fromSeq: fromN,
    toSeq: toN,
    seqs: seqs.map(Number).filter(Number.isFinite),
    plates: (Array.isArray(plates) ? plates : []).map(String),
    text: String(text || '').slice(0, 400000),
  }
  let file = null
  try {
    const dir = handoffDir(cfg)
    fs.mkdirSync(dir, { recursive: true })
    file = path.join(dir, String(sid).slice(0, 24) + '-' + fromN + '-' + toN + '.json')
    fs.writeFileSync(file, JSON.stringify(payload, null, 1))
  } catch (e) { log('交接清单写入失败：' + (e?.message ?? e)) }
  if (cfg.handoffEvent) {
    try { ctx.emit?.('log-prune/pruned', { ...payload, file }) } catch (e) { log('交接事件发出失败：' + (e?.message ?? e)) }
  }
  log('已交接 ' + String(sid).slice(0, 20) + ' seq ' + fromN + '-' + toN + (file ? ' → ' + file : ''))
  return file
}
