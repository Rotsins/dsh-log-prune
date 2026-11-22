// 5.4（2026-11-19）：表面重放 / 轮次切分 / 裁切选段 —— 从 index.js 抽出的纯函数（只搬不改）。
import { dayOf } from './daycut.mjs'
import { isPlaceholder } from './plate.mjs'
import { charLen } from './msgtext.mjs'

// 默认值（实际裁切调用方会传 cfg.keepTurns；这里只对未传参的单测/旧口径生效）
const KEEP_TURNS = 3

const SURFACE_EVENT_TYPES = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result'])

export function replaySurfaceSpan(eventAt, startSeq, endSeq, untilSeq) {
  const surface = [];
  let until = typeof untilSeq === 'number' ? untilSeq : Math.max(startSeq, endSeq);
  if (typeof untilSeq !== 'number') while (eventAt(until + 1)) until++;
  for (let seq = 0; seq <= until; seq++) {
    const ev = eventAt(seq);
    if (!ev || !SURFACE_EVENT_TYPES.has(ev.type)) continue;
    const op = ev.surfaceOp;
    if (op === 'append') { surface.push(seq); continue; }
    if (!op || typeof op !== 'object') return null;
    const a = surface.indexOf(op.startSeq);
    const b = surface.indexOf(op.endSeq);
    if (a < 0 || b < a) return null;
    surface.splice(a, b - a + 1, seq);
  }
  const i = surface.indexOf(startSeq);
  const j = surface.indexOf(endSeq);
  if (i < 0 || j < i) return null;
  return surface.slice(i, j + 1);
}

export function buildTurns(nodes) {
  const turns = [];
  let cur = null;
  for (const n of nodes) {
    if (!cur) {
      if (n.type !== 'user/message') continue;
      cur = { startSeq: n.seq, endSeq: n.seq, day: dayOf(n.time), seqs: [n.seq] };
      turns.push(cur);
      continue;
    }
    if (n.type === 'user/message') {
      cur = { startSeq: n.seq, endSeq: n.seq, day: dayOf(n.time), seqs: [n.seq] };
      turns.push(cur);
    } else {
      cur.endSeq = n.seq;
      cur.seqs.push(n.seq);
    }
  }
  return turns;
}

export function pickDaySpans(turns, { today, allowToday = false, archived = () => null, keepTurns = KEEP_TURNS, isPlate = () => false } = {}) {
  const limit = turns.length - keepTurns;
  const spans = [];
  let cur = null;
  let prevOk = -1;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const ok = i < limit && !isPlate(t.startSeq) && !t.seqs.some((s) => !archived(s)) &&
      (allowToday || !today || t.day < today);
    if (!ok) { cur = null; continue; }
    if (cur && cur.day === t.day && prevOk === i - 1) {
      cur.endSeq = t.endSeq;
      cur.count += t.seqs.length;
      cur.seqs.push(...t.seqs);
    } else {
      cur = { day: t.day, startSeq: t.startSeq, endSeq: t.endSeq, count: t.seqs.length, seqs: [...t.seqs] };
      spans.push(cur);
    }
    prevOk = i;
  }
  return spans;
}

export function pickBudgetSpans(turns, { tokens = 0, keepTokens = 0, archived = () => null, keepTurns = KEEP_TURNS, isPlate = () => false, shadowOf = () => 0 } = {}) {
  const limit = turns.length - keepTurns;
  const spans = [];
  let cur = null;
  let used = 0;
  for (let i = 0; i < turns.length && i < limit; i++) {
    if (tokens - used <= keepTokens) break;
    const t = turns[i];
    if (isPlate(t.startSeq)) { cur = null; continue; }
    if (t.seqs.some((s) => !archived(s))) { cur = null; continue; }
    used += Math.max(1, shadowOf(t));
    if (cur && cur.day === t.day) {
      cur.endSeq = t.endSeq;
      cur.count += t.seqs.length;
      cur.seqs.push(...t.seqs);
    } else {
      cur = { day: t.day, startSeq: t.startSeq, endSeq: t.endSeq, count: t.seqs.length, seqs: [...t.seqs] };
      spans.push(cur);
    }
  }
  return spans;
}

export function selectCutSpans(turns, { summarySeq = 0, tokens = 0, keepTokens = 0, keepTurns = 3, archived = () => null, isPlate = () => false, shadowOf = () => 0 } = {}) {
  if (summarySeq) {
    return pickBudgetSpans(turns.filter((t) => t.endSeq < summarySeq), {
      tokens: Number.MAX_SAFE_INTEGER,
      keepTokens: 0,
      keepTurns: 0,
      archived, isPlate, shadowOf,
    });
  }
  return pickBudgetSpans(turns, { tokens, keepTokens, keepTurns, archived, isPlate, shadowOf });
}

export function pickTargets(events, { keepLast = 8, minChars = 1200, archived = () => null } = {}) {
  const toolSeqs = events.filter((e) => e.type === 'tool/result').map((e) => e.seq);
  const cold = new Set(toolSeqs.slice(0, Math.max(0, toolSeqs.length - keepLast)));
  const out = [];
  for (const e of events) {
    if (e.type !== 'tool/result' || !cold.has(e.seq)) continue;
    if (isPlaceholder(e.message)) continue;
    if (charLen(e.message) < minChars) continue;
    const arch = archived(e.seq);
    if (!arch) continue;
    out.push({ seq: e.seq, ...arch });
  }
  return out;
}

export function balancedUpTo(order, session, uptoSeq, countToolCallEvents = true) {
  let open = 0;
  for (const seq of order) {
    const ev = session.eventAt(seq);
    const t = ev?.type ?? '';
    if (t === 'tool/result') open -= 1;
    else if (t === 'tool/call') { if (countToolCallEvents) open += 1; }
    else if (t === 'assistant/message' && !countToolCallEvents) {
      for (const b of ev?.data?.message?.content ?? []) if (b.type === 'tool-call') open += 1;
    }
    if (open < 0) return false;
    if (seq === uptoSeq) return open === 0;
  }
  return uptoSeq === undefined ? true : false;
}
