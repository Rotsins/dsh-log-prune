// 5.4（2026-11-19）：摘要落地检测 / 扫描 —— 从 index.js 抽出的纯函数（只搬不改）。
export const SUMMARY_MARK = /^(?:【裁切摘要】|\[裁切摘要\])/;
export const TASK_MARK = '【裁切摘要任务】';
export const IGNORE_MARK = /忽略本次摘要任务|上下文已低于阈值/;

// 2026-11-16 两次修正：①不再「出现即算」，任务提示词会自称摘要；②逐块判，reasoning 在前也不漏。
export const isSummaryText = (blocks) => {
  const list = Array.isArray(blocks)
    ? blocks
    : (typeof blocks === 'string' ? [{ type: 'text', text: blocks }] : []);
  // 2026-11-19 T3 修复：只认 text 块。reasoning 里引用「【裁切摘要】/覆盖：seq …」是模型
  // 在思考里计划格式，不是正文落地；真实正文按任务要求写在 text（instruction 第 8 条）。
  const texts = list
    .filter((b) => b && b.type === 'text')
    .map((b) => (b.text || '').trim());
  if (texts.some((t) => SUMMARY_MARK.test(t))) return true;
  if (texts.some((t) => t.indexOf(TASK_MARK) >= 0)) return false;
  return false;
};

/** 表面 base 之后有没有模型回「忽略本次摘要任务」 */
export function scanIgnoredReply(session, base = 0) {
  for (const s of [...session.surface.nodes]) {
    if (s <= base) continue;
    const ev = session.eventAt(s);
    if (ev?.type !== 'assistant/message') continue;
    const blocks = session.deriveEventMessage?.(ev)?.content;
    const text = Array.isArray(blocks)
      ? blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n')
      : (typeof blocks === 'string' ? blocks : '');
    const _t = text.trim();
    if (_t.startsWith('忽略本次摘要任务') && _t.length < 500) return s;
  }
  return 0;
}

export function scanSummarySeq(session, base = 0) {
  let seq = 0;
  for (const s of [...session.surface.nodes]) {
    if (s <= base) continue;
    const ev = session.eventAt(s);
    if (ev?.type !== 'user/message' && ev?.type !== 'assistant/message') continue;
    const blocks = session.deriveEventMessage?.(ev)?.content;
    if (isSummaryText(blocks)) seq = s;
  }
  return seq;
}
