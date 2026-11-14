// 交接：把裁掉的一段交给别的插件（默认关）
// 产物：<handoffDir>/<sid>-<from>-<to>.json（清单，含文本与门牌线索）+ 事件 log-prune/pruned
import fs from 'node:fs'
import path from 'node:path'
import { resolveHome } from './home.mjs'

export function handoffDir(cfg) {
  return cfg.handoffDir || path.join(resolveHome(), 'state/pruned-outbox')
}

export function deliver(ctx, log, cfg, { sid, from, to, seqs, text, plates = [] }) {
  if (!cfg.handoffEnabled) return null
  const payload = {
    v: 1,
    at: new Date().toISOString(),
    sessionId: sid,
    fromSeq: from,
    toSeq: to,
    seqs,
    plates,
    text: String(text || '').slice(0, 400000),
  }
  let file = null
  try {
    const dir = handoffDir(cfg)
    fs.mkdirSync(dir, { recursive: true })
    file = path.join(dir, sid.slice(0, 24) + '-' + from + '-' + to + '.json')
    fs.writeFileSync(file, JSON.stringify(payload, null, 1))
  } catch (e) { log('交接清单写入失败：' + (e?.message ?? e)) }
  if (cfg.handoffEvent) {
    try { ctx.emit?.('log-prune/pruned', { ...payload, file }) } catch (e) { log('交接事件发出失败：' + (e?.message ?? e)) }
  }
  log('已交接 ' + sid.slice(0, 20) + ' seq ' + from + '-' + to + (file ? ' → ' + file : ''))
  return file
}
