// era.mjs —— 时代摘要合并（O2，2026-11-20）
// 触发：门牌块数 ≥ eraMergePlates，或旧摘要条数 ≥ eraMergeSummaries。
// 动作：派一条「合并模式」的【裁切摘要任务】；模型把当前上下文里所有旧摘要 + 旧门牌合并成一份时代摘要，
//       落地后走既有的上弦裁切（把新摘要之前的全部内容换成一块总门牌）。全部机制复用，不引入新写法。
import { parsePlate } from './plate.mjs'
import { isSummaryText } from './summary.mjs'

function textOf(m) {
  const blocks = m?.content
  if (typeof blocks === 'string') return blocks
  return Array.isArray(blocks) ? blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n') : ''
}

export function deriveMsg(session, ev) {
  try { return session?.deriveEventMessage?.(ev) ?? { content: [] } } catch { return { content: [] } }
}

/**
 * 扫当前表面上的「常驻残留」：
 *   plates    —— 所有 [.. 全天记录已归档 ..] 门牌（parsePlate 解析成功的）
 *   summaries —— 所有以「【裁切摘要】」开头的旧摘要（含最新一份；落地裁切会把它们全部合并/裁掉）
 * 返回 { plates, summaries, firstSeq, lastSeq }：first/last 是残留块在表面上的起止 seq。
 */
export function scanResidue(session) {
  const plates = []
  const summaries = []
  let firstSeq = 0
  let lastSeq = 0
  const touch = (seq) => { if (!firstSeq) firstSeq = seq; lastSeq = seq }
  const nodes = [...(session?.surface?.nodes ?? [])]
  for (const seq of nodes) {
    const ev = session.eventAt?.(seq)
    if (!ev || ev.type === 'system/message') continue
    const m = deriveMsg(session, ev)
    if (ev.type === 'user/message') {
      const p = parsePlate(m)
      if (p && p.start > 0 && p.end >= p.start) { plates.push({ seq, ...p }); touch(seq); continue }
    }
    if (isSummaryText(m?.content)) { summaries.push({ seq, text: textOf(m).slice(0, 4000) }); touch(seq) }
  }
  return { plates, summaries, firstSeq, lastSeq }
}

/** 触发判断：门牌块数达标 或 旧摘要条数达标（配置项 clampCfg 已保证 ≥2） */
export function eraNeeded(residue, cfg) {
  const needPlates = Math.max(2, Number(cfg?.eraMergePlates || 4))
  const needSums = Math.max(2, Number(cfg?.eraMergeSummaries || 2))
  return residue.plates.length >= needPlates || residue.summaries.length >= needSums
}

/**
 * 合并模式指令（O4：时代合并不要求「门牌索引」复述行——旧门牌马上会被总门牌替代，抄一遍是纯浪费）。
 * 第一行仍是【裁切摘要任务】：落地检测 / inbox 看门 / 上弦流程零改动。
 */
export function eraInstruction({ from, to }) {
  return [
    '【裁切摘要任务】（时代合并）把本会话里现存的旧摘要与门牌合并成一份「时代摘要」。',
    '要求：',
    '1. 文本第一行必须原样以「【裁切摘要】」开头；第二行写「覆盖：seq ' + from + '-' + to + '」。',
    '2. 合并模式：把当前上下文里所有以「【裁切摘要】」开头的旧摘要正文，与所有 [.. 全天记录已归档 · .. seq=..] 门牌行，',
    '   合并为一份时代摘要——按「结论 / 决定 / 约定 / 未完成事项 / 关键路径与命令」分层列出，不要复述原文。',
    '3. 旧摘要之间重复的信息只写一次；彼此矛盾的以较新者为准，并在其后注明（曾记为 X）。',
    '4. 正文不超过 3000 字；旧摘要里提到的长文落盘路径要全部保留。',
    '5. 当前 token 以 log_prune_status 的返回为准，不要自己数上下文。',
    '6. 除了查 token 用的 log_prune_status，不要调用其他工具。',
    '7. 摘要正文必须写成普通回复（text），不要只放在思考（reasoning）里，也不要回复「忽略本次摘要任务」。',
  ].join('\n')
}
