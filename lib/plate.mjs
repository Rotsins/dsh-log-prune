// 5.4（2026-11-19）：门牌纯函数 —— 从 index.js 抽出（只搬不改）。
// 含：门牌合并决策、门牌解析、链式归并、条数窗口、占位符识别。
export const PLATE_MERGE = process.env.DSH_PRUNE_PLATE_MERGE === '1';

export function decidePlateMerge(order, iA0, iB0, prevPlateSeq, endSeq, isSynthetic, isSummaryNode, isSystem, enabled = PLATE_MERGE) {
  const canMerge = enabled && prevPlateSeq !== null && prevPlateSeq !== undefined && Number(prevPlateSeq) < Number(endSeq);
  if (canMerge && order[iA0] === prevPlateSeq) {
    let j = iA0 - 1;
    while (j >= 0 && order[j] === prevPlateSeq) j--;
    while (j >= 0 && isSynthetic(order[j])) {
      if (isSummaryNode && isSummaryNode(order[j])) return { mergePlate: false, iA0, skippedLead: 0 };
      if (isSystem && isSystem(order[j])) return { mergePlate: false, iA0, skippedLead: 0 };
      j--;
    }
    if (j >= 0 && isSystem && isSystem(order[j])) return { mergePlate: false, iA0, skippedLead: 0 };
    if (j >= 0) return { mergePlate: true, iA0: j, skippedLead: iA0 - j };
    return { mergePlate: false, iA0, skippedLead: 0 };
  }
  let i = iA0, skippedLead = 0;
  while (i >= 0 && i + 1 <= iB0 && (order[i + 1] <= order[i] || isSynthetic(order[i]))) { i++; skippedLead++; }
  return { mergePlate: false, iA0: i, skippedLead };
}

// 兼容旧门牌：旧格式结尾没有「翻原文/找内容」，而是「摘要之前的记录已裁」等说明。
export const PLATE_RE = /^\[(\d{4})-(\d{2})-(\d{2}) 全天记录已归档 · (\d+) 条 · (?:原文 (.+?) · )?seq=(\d+)-(\d+)(?: ·|\])/;

export function parsePlate(msg) {
  const t = String(msg?.content?.[0]?.text ?? '');
  const m = PLATE_RE.exec(t);
  if (!m) return null;
  return { day: m[1] + m[2] + m[3], count: Number(m[4]), file: m[5] || '', start: Number(m[6]), end: Number(m[7]) };
}

export function mergePlateChain(plates, cutStart, baseCount = 0, gap = 10000) {
  const list = (Array.isArray(plates) ? plates : []).filter((p) => p && Number.isFinite(p.start) && Number.isFinite(p.end) && p.start > 0 && p.end >= p.start);
  let cur = Number(cutStart) || 0;
  const used = [];
  const usedSeqs = new Set();
  let count = Number(baseCount) || 0;
  let covers = null;
  for (const p of list) {
    if (!(p.start <= cur && p.end >= cur)) continue;
    if (!covers || p.start < covers.start) covers = p;
  }
  if (covers) {
    usedSeqs.add(covers.seq);
    used.push(covers);
    count += covers.count;
    cur = covers.start;
  }
  for (let guard = 0; guard < 100; guard++) {
    let best = null;
    for (const p of list) {
      if (usedSeqs.has(p.seq)) continue;
      if (!(p.end < cur)) continue;
      if (!best || p.end > best.end) best = p;
    }
    if (!best) break;
    if (gap > 0 && cur - best.end > gap) break;
    usedSeqs.add(best.seq);
    used.push(best);
    count += best.count;
    cur = best.start;
  }
  return { start: used.length ? used[used.length - 1].start : cur, count, file: used[used.length - 1]?.file || '' };
}

export function plateWindowDays(targetTokens, avgDaily, { min = 2, max = 7 } = {}) {
  const target = Math.round(targetTokens);
  if (!(avgDaily > 0)) return max;
  return Math.max(min, Math.min(max, Math.floor(target / avgDaily)));
}

export const ARCHIVE_RE = /^\[归档\] (.+?) 的 (\d+) 条记录已移出会话 · 原文 (.+?) · seq=(\d+)-(\d+)/;

export const isPlaceholder = (msg) => {
  const t = String(msg?.content?.[0]?.text ?? '');
  // 门牌必须是「[日期 全天记录已归档 ...]」开头、工具结果占位必须是「[某轮的工具结果已归档 ...]」开头；
  // 不能用 includes，否则工具结果/正文里提到这些字眼会被误判成占位（体积统计虚高、裁切误跳过）。
  const toolPlate = t.startsWith('[') && t.includes('的工具结果已归档')
  return toolPlate || PLATE_RE.test(t) ||
    t.startsWith('[更早的 ') || ARCHIVE_RE.test(t);
};

export const isLongText = (msg) => String(msg?.content?.[0]?.text ?? '').trim().startsWith('【长文落盘】');
