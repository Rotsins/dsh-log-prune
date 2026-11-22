// 5.2（2026-11-19）：状态文件读写 —— 从 index.js 抽出的纯 I/O 模块（熔断名单/裁切状态/校准/通用 JSON）。
// 只搬不改：函数体与 index.js 原实现一致，路径语义不变。
import fs from 'node:fs'
import path from 'node:path'
import { resolveHome } from './home.mjs'
import { writeJsonAtomic } from './atomic.mjs'

const HOME = resolveHome()

export const FUSE_FILE = process.env.DSH_LOG_PRUNE_FUSE ?? path.join(HOME, 'state', 'prune-broken.json')
export const STATUS_FILE = process.env.DSH_LOG_PRUNE_STATUS ?? path.join(HOME, 'state', 'prune-status.json')
export const CALIB_FILE = process.env.DSH_LOG_PRUNE_CALIB ?? path.join(HOME, 'state', 'prune-calib.json')

export function readFuse(file = FUSE_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { return {}; }
}

export function tripFuse(sid, reason) {
  const m = readFuse();
  m[sid] = { at: new Date().toISOString(), reason: String(reason).slice(0, 300) };
  try { writeJsonAtomic(FUSE_FILE, m, 1); } catch {}
}

export function readStatus(file = STATUS_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { return {}; }
}

// O16：内容没变就不落盘（同一会话反复检查会写同样的状态，纯 I/O）
const lastStatusText = new Map(); // C4：按会话记，跨会话共用一个字符串会让去重基本失效
export function writeStatus(sid, patch) {
  try {
    const m = readStatus();
    m[sid] = Object.assign(m[sid] || {}, patch, { at: new Date().toISOString() });
    // O2：失败原因单独留一份，面板/诊断页不用再翻日志；成功即清掉
    if (patch && patch.ok === false) m[sid].lastError = { at: m[sid].at, reason: String(patch.reason || patch.error || patch.detail || 'ok=false').slice(0, 300) };
    else if (patch && patch.ok === true) delete m[sid].lastError;
    // P12：按本会话那一条比较；拿整份文件比，跨会话交替时永远在变，去重等于没有
    const one = JSON.stringify(m[sid]);
    if (lastStatusText.get(sid) === one) return;
    lastStatusText.set(sid, one);
    writeJsonAtomic(STATUS_FILE, m, 1);
  } catch {}
}

// P4/H3：兼容旧数据（orphanRisk 曾是 "起-止" 字符串 + 独立 orphanAt 字段）
export function orphanOf(status) {
  if (!status) return null;
  const o = status.orphanRisk;
  if (!o) return null;
  if (typeof o === 'string') return { seq: 0, range: o, at: status.orphanAt || '', reason: status.reason || '' };
  if (typeof o !== 'object') return null;
  return {
    seq: Number(o.seq) || 0,
    range: String(o.range || ''),
    at: String(o.at || ''),
    reason: String(o.reason || ''),
  };
}

// P4/H4：清孤儿提示走统一出口；writeStatus 里 JSON.stringify 会丢掉 undefined 键 = 删除
export function clearOrphanRisk(sid) {
  const st = readStatus()[sid];
  if (!st || !st.orphanRisk) return false;
  writeStatus(sid, { orphanRisk: undefined, orphanAt: undefined });
  return true;
}

export function clearFuse(sid) {
  let removed = false;
  try {
    const m = readFuse();
    if (m && m[sid]) { delete m[sid]; removed = true; writeJsonAtomic(FUSE_FILE, m, 1); }
  } catch {}
  try {
    const s = readStatus();
    if (s && s[sid]) { delete s[sid]; writeJsonAtomic(STATUS_FILE, s, 1); }
  } catch {}
  return removed;
}

export function readStateFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} }
}

export function readCalib() {
  try { return JSON.parse(fs.readFileSync(CALIB_FILE, 'utf8')) } catch { return {} }
}
export function writeCalib(m) {
  try { writeJsonAtomic(CALIB_FILE, m) } catch {}
}
