// dsh-log-prune —— 按 token 预算裁切：从最早一轮往后累加，剩到「保留线」就停，裁掉的段换成一行日期门牌
// 口径：只改工作台视图，不删日志；每个节点必须已经进镜像/归档；最近的轮次不动；出错一律不裁
// 替换方式对齐官方 compaction：compaction/prune + user/message(surfaceOp replace start..end)
export const name = 'log-prune';
export const inject = ['webServer', 'agents'];

import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fromHostTree } from './hostdeps.mjs';
import { loadConfig, ensureConfigFile, saveConfig, CONFIG_PATH, effectiveConfig, loadSessions, setSessionOverride, clearSessionOverride } from './config.mjs';
import { startWatcher } from './watcher.mjs';
import { fileURLToPath } from 'node:url';
import { deliver } from './handoff.mjs';
import { resolveHome } from './home.mjs';
import { zstdDecompressSync } from 'node:zlib';
import { decompress as fzstdDecompress } from './vendor/fzstd.mjs';

const HOME = resolveHome();

const KEEP_TURNS = Number(process.env.DSH_LOG_PRUNE_KEEP ?? 3);

// —— 固定阈值（不再从压缩峰值学习，数字写死）——
// 当前预设压缩阈值 = 上下文窗口 100 万 × 0.65 = 65 万 token（
// 官方压缩 65 万兜底 / 强制裁切 55 万 / 摘要 40 万起）。
// 强制裁切取压缩线的 55/65 ≈ 0.846，给压缩兜底留 10 万余量。
// ⚠ 换预设、或改预设里的 thresholdRatio 之后，请同步改下面两个数。
const COMPACT_POINT = Number(process.env.DSH_LOG_PRUNE_COMPACT ?? 650000);
const TRIGGER_RATIO = Number(process.env.DSH_LOG_PRUNE_TRIGGER_RATIO ?? (550000 / 650000));
// 保留线：裁完至少留这么多 token（15 万 → 10 万，省冷读；窗口 10%）。只留几万 token 跟压缩没区别。
const KEEP_TOKENS = Number(process.env.DSH_LOG_PRUNE_KEEP_TOKENS ?? 100000);
// 有摘要时的裁切触发线：到点就把摘要之前的全裁掉（只留摘要+门牌+最近两轮）
const SUMMARY_TRIGGER = Number(process.env.DSH_LOG_PRUNE_SUMMARY_TRIGGER ?? 400000);
// 长文落盘：单条 user 消息超过这个字数就写盘，面上只留指针
const LONG_TEXT_LIMIT = Number(process.env.DSH_LOG_PRUNE_LONGTEXT ?? 8192);
const LONGTEXT_ROOT = process.env.DSH_LOG_PRUNE_LONGTEXT_DIR ?? HOME + '/inbox/longtext';
const LT_STATE_DIR = HOME + '/state/longtext';
// 熔断名单：核心连续拒绝三次（重试两次）才写进这里，之后该会话不再裁，并往会话里留一条提示
const FUSE_FILE = process.env.DSH_LOG_PRUNE_FUSE ?? HOME + '/state/prune-broken.json';
export function readFuse(file = FUSE_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { return {}; }
}
function tripFuse(sid, reason) {
  const m = readFuse();
  m[sid] = { at: new Date().toISOString(), reason: String(reason).slice(0, 300) };
  try { fs.writeFileSync(FUSE_FILE, JSON.stringify(m, null, 1)); } catch {}
}
// 保留线由 KEEP_TOKENS 直接给出（见上），不再按比例折算
const CALIB_FILE = process.env.DSH_LOG_PRUNE_CALIB ?? HOME + '/state/prune-calib.json';
const TOK_DIR = process.env.DSH_LOG_PRUNE_TOKDIR ?? HOME + '/state/prune-tokens';
const ARCHIVE_DIR = process.env.DSH_LOG_ARCHIVE ?? HOME + '/记忆/日志存档';
const MIRROR_DIR = process.env.DSH_LOG_MIRROR ?? HOME + '/记忆/镜像';
// Windows 上 spawn 必须隐藏窗口（否则每读一次归档闪一次 cmd），并且只探测一次
let zstdOk = null
// 读 zstd 文件：DSH 的日志是多帧拼接，Node 内置的 zstdDecompressSync 只解第一帧还当成功，
// 所以纯 JS 解码器放第一位（它能逐帧解全），内置和系统命令只作兜底。
function readZstd(file) {
  const buf = fs.readFileSync(file);
  try { return Buffer.from(fzstdDecompress(buf)).toString('utf8') } catch {}
  if (typeof zstdDecompressSync === 'function') {
    try { return zstdDecompressSync(buf).toString('utf8') } catch {}
  }
  if (canZstd()) {
    try { return execFileSync('zstd', ['-dc', file], { encoding: 'utf8', maxBuffer: 1 << 30, windowsHide: true }) } catch {}
  }
  throw new Error('zstd 解压失败：' + file);
}

function canZstd() {
  if (zstdOk !== null) return zstdOk
  try { execFileSync('zstd', ['--version'], { stdio: 'ignore', windowsHide: true }); zstdOk = true } catch { zstdOk = false }
  return zstdOk
}

const DRY = process.env.DSH_LOG_PRUNE_DRY === '1';
const CACHE_MS = 30000;
const TZ = 'Asia/Shanghai';

// 作息日口径：宿主有 lib/daycut.mjs 就用它，没有就用插件自带的那份
const _day = await (async () => {
  try { return await import(HOME + '/lib/daycut.mjs') } catch { return await import('./daycut.mjs') }
})();
const { dayOf, prettyDay } = _day;

export const DAY_PLACEHOLDER = (day, count, file, sid, a, b, longtexts = []) =>
  '[' + prettyDay(day) + ' 全天记录已归档 · ' + count + ' 条 · 原文 ' + file + ' · seq=' + a + '-' + b +
  ' · 翻原文：用插件 lib/vendor/fzstd.mjs 的 decompress(buf) 解压该文件，再按 seq 区间取' +
  (longtexts.length ? '\n· 长文落盘 ' + longtexts.length + ' 篇：' + longtexts.join('；') : '') + ']';

/** 门牌保留窗口：最近 N 天（N 由压缩点和日均新增 token 决定，2~7 天） */
const PLATE_RE = /^\[(\d{4})-(\d{2})-(\d{2}) 全天记录已归档 · (\d+) 条 · 原文 (.+?) · seq=(\d+)-(\d+) · 翻原文/;

/** 从已有门牌里读回日期/条数/原文/seq 区间，用于合并 */
export function parsePlate(msg) {
  const t = String(msg?.content?.[0]?.text ?? '');
  const m = PLATE_RE.exec(t);
  if (!m) return null;
  return { day: m[1] + m[2] + m[3], count: Number(m[4]), file: m[5], start: Number(m[6]), end: Number(m[7]) };
}

export function plateWindowDays(targetTokens, avgDaily, { min = 2, max = 7 } = {}) {
  const target = Math.round(targetTokens);
  if (!(avgDaily > 0)) return max;
  return Math.max(min, Math.min(max, Math.floor(target / avgDaily)));
}

export const META_PLACEHOLDER = (days, count, sid) =>
  '[更早的 ' + days + ' 天记录已归档 · ' + count + ' 条 · 按日期看 timeline，或按关键词在归档文件里搜]';

export const ARCHIVE_RE = /^\[归档\] (.+?) 的 (\d+) 条记录已移出会话 · 原文 (.+?) · seq=(\d+)-(\d+)/;

export const isPlaceholder = (msg) => {
  const t = String(msg?.content?.[0]?.text ?? '');
  return t.includes('的工具结果已归档') || t.includes('全天记录已归档') || ARCHIVE_RE.test(t);
};

/** 长文落盘标记：正文已写到磁盘，消息里只留路径+摘要，裁切时按「已归档」对待 */
export const isLongText = (msg) => String(msg?.content?.[0]?.text ?? '').trim().startsWith('【长文落盘】');

// 摘要写入后立刻裁切的开关（默认关，按会话键打开）
const AFTER_SUMMARY_FILE = HOME + '/state/prune-after-summary.json';
export function pruneAfterSummaryEnabled(sid) {
  try { return JSON.parse(fs.readFileSync(AFTER_SUMMARY_FILE, 'utf8'))[sid] === true } catch { return false }
}

export function charLen(msg) {
  let n = 0;
  for (const block of msg?.content ?? []) if (block.type === 'text') n += Array.from(block.text ?? '').length;
  return n;
}

const SURFACE_EVENT_TYPES = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result']);

/**
 * 纯函数：按落盘日志的表面规则重放出 [startSeq, endSeq] 这段当前的表面节点。
 * 运行时 session.surface.nodes 并不等于磁盘重放的表面（会漏 system/message），
 * 所以替换区间必须自己重放算一遍，和恢复时的校验器用同一套规则。
 * 表面不自洽就返回 null —— 宁可不裁，也不写坏日志。
 */
export function replaySurfaceSpan(eventAt, startSeq, endSeq, untilSeq) {
  // 门牌/压缩节点是后插入的，seq 可能比区间末尾还大：默认重放到日志最后一条，
  // 否则会漏掉后插入的替换节点，算出压缩前的旧表面（2026-11-06 会话损坏就是这么来的）
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

/** 纯函数：把节点切成轮次（user/message 起头），给每轮打日期 */
export function buildTurns(nodes) {
  const turns = [];
  let cur = null;
  for (const n of nodes) {
    // 开头的系统提示等非 user 节点不能算一轮（替换它会踩到 system prompt 保护）
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

/** 纯函数：旧口径（按天整段挑，已不再用于裁切，保留给单测） */
export function pickDaySpans(turns, { today, allowToday = false, archived = () => null, keepTurns = KEEP_TURNS, isPlate = () => false } = {}) {
  const limit = turns.length - keepTurns;
  const spans = [];
  let cur = null;
  let prevOk = -1;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    // 当天轮次默认不裁，只有实验组越过兜底线（allowToday）才放开
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

/**
 * 纯函数：按 token 预算裁切 —— 从最早一轮往后累加，剩到 keepTokens 就停。
 * 不再按天整段吞：预算落在某天中间时，只裁那天靠前的那部分（同一天的门牌会累计合并）。
 * shadowOf(turn) 返回该轮大概占多少 token；门牌本身和没进镜像/归档的轮次一律跳过。
 */
export function pickBudgetSpans(turns, { tokens = 0, keepTokens = 0, archived = () => null, keepTurns = KEEP_TURNS, isPlate = () => false, shadowOf = () => 0 } = {}) {
  const limit = turns.length - keepTurns;
  const spans = [];
  let cur = null;
  let used = 0;
  for (let i = 0; i < turns.length && i < limit; i++) {
    if (tokens - used <= keepTokens) break; // 已经切够了，剩下的留着
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

/** 纯函数：旧口径（逐条工具结果）——保留给单测 */
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

const cache = new Map();

export function loadArchive(sid, archiveDir = ARCHIVE_DIR, now = Date.now()) {
  const hit = cache.get(sid);
  if (hit && now - hit.at < CACHE_MS) return hit.map;
  const map = new Map();
  try {
    const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith(sid + '.日志'));
    for (const f of files) {
      const full = path.join(archiveDir, f);
      let text;
      try { text = readZstd(full); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (typeof e.seq !== 'number' || e.seq < 0) continue;
        map.set(e.seq, { file: full, day: dayOf(e.time), when: new Date(e.time).toLocaleString('sv-SE', { timeZone: TZ }) });
      }
    }
  } catch { /* 目录不在就当没归档 */ }
  cache.set(sid, { at: now, map });
  return map;
}


// 兜底归档：直接读 DSH 自己的会话日志（session.v4.jsonl.zstd / .jsonl）
// 没有镜像/归档插件的机器靠这个确认「原文还在」，才允许裁。
const sessionLogCache = new Map();
export function loadSessionLog(sid, home = HOME, now = Date.now()) {
  const hit = sessionLogCache.get(sid);
  if (hit && now - hit.at < CACHE_MS) return hit.map;
  const map = new Map();
  let wsDirs = [];
  try { wsDirs = fs.readdirSync(path.join(home, 'sessions')) } catch { return map }
  for (const ws of wsDirs) {
    const dir = path.join(home, 'sessions', ws, sid);
    const zst = path.join(dir, 'session.v4.jsonl.zstd');
    const plain = path.join(dir, 'session.v4.jsonl');
    let text = null;
    try {
      if (fs.existsSync(zst)) text = readZstd(zst);
      else if (fs.existsSync(plain)) text = fs.readFileSync(plain, 'utf8');
    } catch { text = null }
    if (!text) continue;
    for (const line of text.split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line) } catch { continue }
      if (typeof e.seq !== 'number' || e.seq < 0) continue;
      map.set(e.seq, { file: fs.existsSync(zst) ? zst : plain, day: dayOf(e.time ?? Date.now()), when: new Date(e.time ?? Date.now()).toLocaleString('sv-SE', { timeZone: TZ }) });
    }
  }
  sessionLogCache.set(sid, { at: now, map });
  return map;
}

const mirrorCache = new Map();
const done = new Set(); // 本进程内已经裁过的区间，防重复追加标记

/** 读镜像区（当天实时镜像 + 已封存的副本），只认逐行解析通过的事件 */
export function loadMirror(sid, dir = MIRROR_DIR, now = Date.now()) {
  const hit = mirrorCache.get(sid);
  if (hit && now - hit.at < CACHE_MS) return hit.map;
  const map = new Map();
  const scan = (d) => {
    let names = [];
    try { names = fs.readdirSync(d).filter((f) => f.includes('_' + sid + '.jsonl')); } catch { return; }
    for (const f of names) {
      const full = path.join(d, f);
      let text;
      try {
        text = f.endsWith('.zst') ? readZstd(full) : fs.readFileSync(full, 'utf8');
      } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (typeof e.seq !== 'number' || e.seq < 0) continue;
        if (!map.has(e.seq)) map.set(e.seq, { file: full, day: dayOf(e.time), mirror: true });
      }
    }
  };
  scan(dir);
  scan(path.join(dir, '已封存'));
  mirrorCache.set(sid, { at: now, map });
  return map;
}

/** 工具配对平衡：数「未闭合的工具调用」，用事件类型数而不是官方 assistant/message 里的 tool-call 块 */
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

let sharedConfigRoute = false;
let sharedUiRoute = false;
export function apply(ctx) {
  const log = (m) => {
    try { ctx.logger?.info?.('[log-prune] ' + m); } catch {}
    try { fs.appendFileSync(path.join(tmpdir(), 'log-prune.log'), new Date().toISOString() + ' ' + m + "\n"); } catch {}
  };
  let freezeMessage = null;
  let createUserMessage = null;
  let canWrite = false;
  // 宿主工厂拿不到时，自建消息也必须带 id（核心只校验 id；上次写坏就是少了它）
  const buildUserMessage = (content, source) => {
    if (createUserMessage) return createUserMessage({ content, source })
    if (freezeMessage) return freezeMessage({ role: 'user', content, source })
    return { id: randomUUID(), role: 'user', content, source }
  };
  let balancedBefore = null;
  let balancedAfter = null;

  // —— 配置：首次启动补一份带注释的 YAML，之后每轮热读 ——
  try { ensureConfigFile() } catch (e) { log('写默认配置失败：' + (e?.message ?? e)) }

  // —— 摘要轮询（原先的 bin/summary-watcher.mjs 收编进来）——
  // 进程内派发：不依赖 HTTP 端口/客户端模块，桌面版也能用
  const deliverPrompt = (sid, text) => {
    const agents = ctx.get('agents');
    const agent = agents?.get?.(sid);
    if (!agent || typeof agent.followup !== 'function') return false;
    const msg = buildUserMessage([{ type: 'text', text }], { kind: 'user', rpcId: 'prune-summary-' + Date.now() });
    agent.followup(msg);
    return true;
  };
  // 判断内存里的插件是不是最新：比对插件文件 mtime 与进程启动时间
  try {
    const selfDir = path.dirname(fileURLToPath(import.meta.url));
    const files = ['index.js', 'watcher.mjs', 'config.mjs'];
    let newest = 0, newestFile = '';
    for (const f of files) {
      try {
        const t = fs.statSync(path.join(selfDir, f)).mtimeMs;
        if (t > newest) { newest = t; newestFile = f }
      } catch {}
    }
    const startedAt = Date.now() - process.uptime() * 1000;
    const stale = newest > startedAt + 1000;
    log('插件代码：最新改动 ' + newestFile + ' ' + new Date(newest).toISOString() +
      '，进程启动 ' + new Date(startedAt).toISOString() +
      (stale ? ' → 有更新未加载，需重启' : ' → 已是最新'));
  } catch {}
  const agentsSvc = ctx.get('agents');
  log('agents 服务：' + (agentsSvc?.get ? '可用（进程内派发）' : '不可用（需要 summaryClientPath）'));
  startWatcher(ctx, { getConfig: loadConfig, getConfigFor: (sid) => effectiveConfig(sid), deliverPrompt, log });

  // —— 设置卡片用的配置读写接口 ——
  const 发 = (res, code, obj) => {
    try { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) } catch {}
  };
  // 同一进程里可能被多个预设各挂一次，路由只注册一次
  // 同一进程里可能被多个预设各挂一次，路由只注册一次
  if (!sharedConfigRoute) try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-log-prune/config',
      handler: async (req, res) => {
        try {
          const u = new URL(req.url, 'http://localhost');
          const sid = u.searchParams.get('sid') || '';
          if (req.method === 'GET') {
            const sessions = (() => {
              const dir = TOK_DIR
              const list = []
              try {
                for (const f of fs.readdirSync(dir)) {
                  if (!f.endsWith('.json')) continue
                  const id = f.slice(0, -5)
                  let at = 0
                  try { at = fs.statSync(path.join(dir, f)).mtimeMs } catch {}
                  let cwd = ''
                  try { cwd = JSON.parse(fs.readFileSync(path.join(HOME, 'storages/session_projcache/sessions', id + '.json'), 'utf8'))?.record?.identity?.cwd || '' } catch {}
                  list.push({ id, at, cwd })
                }
              } catch {}
              return list.sort((a, b) => b.at - a.at).slice(0, 20)
            })()
            return 发(res, 200, {
              ok: true, file: CONFIG_PATH,
              config: effectiveConfig(sid),
              global: loadConfig(),
              session: sid ? (loadSessions()[sid] ?? null) : null,
              sessions,
            });
          }
          let body = '';
          for await (const c of req) body += c;
          const j = body ? JSON.parse(body) : {};
          const cfgIn = j.config ?? j;
          const scope = j.scope || 'session';
          const s = String(j.sid || sid || '');
          if (scope === 'global') {
            const cfg = saveConfig(cfgIn);
            return 发(res, 200, { ok: true, scope: 'global', config: cfg });
          }
          if (!s) return 发(res, 400, { ok: false, error: '缺 sid：先选定会话' });
          if (scope === 'follow') {
            clearSessionOverride(s);
            return 发(res, 200, { ok: true, scope: 'follow', config: effectiveConfig(s) });
          }
          setSessionOverride(s, cfgIn);
          发(res, 200, { ok: true, scope: 'session', config: effectiveConfig(s) });
        } catch (e) { 发(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    }));
    sharedConfigRoute = true;
  } catch (e) { log('配置接口注册失败：' + (e?.message ?? e)) }

  // —— 设置面板：宿主给脚本路由 + 往页面注入（绕开 dsh.client 模块图）——
  if (!sharedUiRoute) try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-log-prune/ui.js',
      handler: async (req, res) => {
        try {
          const text = fs.readFileSync(new URL('./ui.js', import.meta.url), 'utf8')
          res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
          res.end(text)
        } catch (e) { try { res.writeHead(404); res.end('ui.js not found') } catch {} }
      },
    }))
    sharedUiRoute = true;
  } catch (e) { log('面板路由失败：' + (e?.message ?? e)) }
  try {
    ctx.on('webserver/index-inject', (table) => {
      if (!Array.isArray(table)) return
      for (const row of table) {
        if (row && row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf('/dsh-log-prune/ui.js') >= 0) return
      }
      table.push({ kind: 'script', placement: 'body', text: 'var _lps=document.createElement("script");_lps.src="/dsh-log-prune/ui.js";document.body.appendChild(_lps);' })
    })
  } catch (e) { log('面板注入失败：' + (e?.message ?? e)) }
  (async () => {
    const llm = await fromHostTree('dsh-llm');
    freezeMessage = llm?.freezeMessage ?? null;
    createUserMessage = llm?.createUserMessage ?? null;
    // 安全闸：拿不到宿主的消息工厂就绝不自拼消息（自拼的会被核心记成无标识事件，写坏会话）
    // 有宿主工厂就用；没有就用带 id 的自建消息（核心只校验 id，不会再写坏会话）
    canWrite = true;
    if (!freezeMessage && !createUserMessage) log('宿主消息工厂缺失：改用自建消息（带 id）')
    const comp = await fromHostTree('dsh-compaction');
    balancedBefore = comp?.toolPairingBalancedBefore ?? null;
    balancedAfter = comp?.toolPairingBalancedAfter ?? null;
    log((freezeMessage || createUserMessage ? '就绪' : '就绪（自建消息）') +
      '（压缩点 ' + COMPACT_POINT + ' × ' + TRIGGER_RATIO + ' = ' + Math.round(COMPACT_POINT * TRIGGER_RATIO) +
      ' 触发 → 裁到剩 ' + KEEP_TOKENS + '，保留最近 ' + KEEP_TURNS + ' 轮' + (DRY ? '，DRY' : '') + '）');
  })();

  const pruneStep = async ({ agent }, next) => {
    try {
      const session = agent?.session;
      const sid = session?.id;
      if (!session || !sid) return next();
      const cfg = effectiveConfig(sid);

      const nodes = [];
      for (const seq of [...session.surface.nodes]) {
        const ev = session.eventAt(seq);
        if (!ev || typeof ev.time !== 'number') continue;
        nodes.push({ seq, type: ev.type, time: ev.time, event: ev });
      }
      nodes.sort((a, b) => a.seq - b.seq);
      if (nodes.length < 8) return next();

      // 当前上下文规模：优先用最近一条 assistant 的实际 prompt_tokens
      let tokens = 0;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const u = nodes[i].event?.data?.usage;
        if (!u) continue;
        const p = u.prompt_tokens ?? u.inputTokens;
        if (typeof p !== 'number') continue;
        const read = u.cacheReadTokens ?? u.cache_read_tokens ?? 0;
        const write = u.cacheWriteTokens ?? 0;
        const total = p + read + write;
        if (total > 0) { tokens = total; break; }
      }
      if (!tokens) {
        let chars = 0;
        for (const n of nodes) {
          const m = session.deriveEventMessage?.(n.event);
          chars += charLen(m);
        }
        tokens = Math.round(chars / 2);
      }
      // 标定文件现在只留诊断用：峰值、压缩次数、索引块水位。阈值已写死，不再从峰值反推
      const calib = (() => { try { return JSON.parse(fs.readFileSync(CALIB_FILE, 'utf8')); } catch { return {}; } })();
      const c = calib[sid] ?? { peak: 0, ends: 0 };
      let ends = 0;
      for (const seq of [...session.surface.nodes]) if (session.eventAt(seq)?.type === 'compaction/end') ends++;
      if (ends > (c.ends ?? 0)) c.peak = tokens;
      c.ends = ends;
      if (tokens > (c.peak ?? 0)) c.peak = tokens;
      calib[sid] = c;
      try { fs.writeFileSync(CALIB_FILE, JSON.stringify(calib)); } catch {}

      log('检查 ' + sid.slice(0, 20) + ' tokens=' + tokens);
      // —— 摘要锚点扫描 + token 状态落盘（给 summary-watcher 用）——
      const messageText = (m) => {
        if (!m) return ''
        if (typeof m === 'string') return m
        const c = m.content
        if (typeof c === 'string') return c
        if (Array.isArray(c)) return c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n')
        return ''
      }
      // —— 长文落盘：单条 user 消息过长就写盘，面上只留一行指针 ——
      // 只动 user 消息（不涉及 assistant 的 tool 调用/结果配对），替换沿用裁切同款影子协议。
      let ltLimit = cfg.longtextLimit
      try {
        const low = JSON.parse(fs.readFileSync(HOME + '/state/prune-lowtest.json', 'utf8'))[sid]
        if (low?.longtext) ltLimit = Number(low.longtext)
      } catch {}
      const ltStateFile = path.join(LT_STATE_DIR, sid + '.json')
      let ltDone0 = []
      try { ltDone0 = JSON.parse(fs.readFileSync(ltStateFile, 'utf8')) } catch {}
      const ltDone = new Set(ltDone0)
      let ltCount = 0
      const ltOrder = [...session.surface.nodes]
      for (const seq of ltOrder) {
        if (ltCount >= 3) break
        const ev = session.eventAt(seq)
        if (ev?.type !== 'user/message') continue
        const m = session.deriveEventMessage?.(ev)
        if (isPlaceholder(m)) continue
        const txt = messageText(m).trim()
        if (!txt || txt.length <= ltLimit || isLongText(m) || ltDone.has(seq)) continue
        try {
          const day = dayOf(ev.time ?? Date.now())
          const dir = path.join(LONGTEXT_ROOT, day)
          fs.mkdirSync(dir, { recursive: true })
          const file = path.join(dir, sid.slice(0, 12) + '-' + seq + '.txt')
          fs.writeFileSync(file, txt)
          const abstract = txt.replace(/\s+/g, ' ').slice(0, 80)
          const sizeKb = (Buffer.byteLength(txt) / 1024).toFixed(1)
          const pointer = '【长文落盘】' + file + ' · ' + sizeKb + ' KB · 摘要：' + abstract
          const msg = buildUserMessage([{ type: 'text', text: pointer }], { kind: 'user', rpcId: 'longtext-' + seq })
          if (!DRY) {
            session.append('compaction/prune', {
              shadowedRange: { start: seq, end: seq },
              shadowedSeqs: [seq],
              shadowedTokenCount: Math.round(txt.length / 2),
            })
            session.append('user/message', msg, {
              surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
              sourceEventSeqs: [seq],
            })
          }
          fs.mkdirSync(LONGTEXT_ROOT, { recursive: true })
          fs.appendFileSync(path.join(LONGTEXT_ROOT, 'index.jsonl'),
            JSON.stringify({ at: Date.now(), sid, seq, path: file, chars: txt.length, abstract }) + '\n')
          ltDone.add(seq)
          ltCount++
          log('长文落盘 seq=' + seq + ' ' + txt.length + ' 字 → ' + file + (DRY ? '（DRY）' : ''))
        } catch (e) {
          log('长文落盘失败 seq=' + seq + '：' + (e?.message ?? e))
        }
      }
      if (ltCount) { try { fs.mkdirSync(LT_STATE_DIR, { recursive: true }); fs.writeFileSync(ltStateFile, JSON.stringify([...ltDone])) } catch {} }
      const SUMMARY_MARK = /^(?:【裁切摘要】|\[裁切摘要\])/
      const surfaceOrder = [...session.surface.nodes]
      let summarySeq = 0
      for (const seq of surfaceOrder) {
        const ev = session.eventAt(seq)
        // 摘要可能落成 user/message（外部写入）也可能落成 assistant/message（会话自己回复），两种都认
        if (ev?.type !== 'user/message' && ev?.type !== 'assistant/message') continue
        const _blocks = session.deriveEventMessage?.(ev)?.content
        const _text = Array.isArray(_blocks)
          ? _blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n')
          : (typeof _blocks === 'string' ? _blocks : '')
        if (SUMMARY_MARK.test(_text.trim())) summarySeq = seq
      }
      const lastSeqNow = surfaceOrder.length ? surfaceOrder[surfaceOrder.length - 1] : 0
      try {
        fs.mkdirSync(TOK_DIR, { recursive: true })
        fs.writeFileSync(path.join(TOK_DIR, sid + '.json'), JSON.stringify({ tokens, lastSeq: lastSeqNow, summarySeq, at: Date.now() }))
      } catch {}
      if (!canWrite) { log('未就绪：宿主消息工厂缺失，本轮只记 token，不裁'); return next(); }
      const fuse = readFuse()[sid];
      if (fuse) { log('熔断中，跳过 ' + sid + '（' + fuse.at + '：' + fuse.reason + '）'); return next(); }
      // 单会话测试覆盖：~/.dsh/state/prune-lowtest.json {"<sid>": {compact, keepTokens, ratio}}
      let compactPoint = cfg.compactPoint, keepTokens = cfg.keepTokens, triggerRatio = cfg.triggerRatio, summaryTrigger = cfg.summaryTrigger;
      try {
        const low = JSON.parse(fs.readFileSync(HOME + '/state/prune-lowtest.json', 'utf8'))[sid];
        if (low) {
          compactPoint = Number(low.compact ?? compactPoint);
          keepTokens = Number(low.keepTokens ?? keepTokens);
          triggerRatio = Number(low.ratio ?? triggerRatio);
          summaryTrigger = Number(low.summaryTrigger ?? summaryTrigger);
          log('低阈值测试覆盖：压缩点 ' + compactPoint + ' × ' + triggerRatio + '，保留 ' + keepTokens);
        }
      } catch {}
      const TRIGGER_TOKENS = Math.round(compactPoint * triggerRatio);
      // 有摘要：到 SUMMARY_TRIGGER 就裁，裁掉摘要前的一切；没摘要：55 万的强制兜底，保留 10 万
      const triggerNow = summarySeq ? Math.min(TRIGGER_TOKENS, summaryTrigger) : TRIGGER_TOKENS;
      if (tokens < triggerNow) { if (tokens) log('未触发：' + tokens + '/' + triggerNow + (summarySeq ? '（摘要裁切）' : '')); return next(); }


      // 覆盖面：先认正式归档包，再认实时镜像（镜像也是事件 JSONL，逐行解析过才算）
      const archiveMap = loadArchive(sid, cfg.archiveDir || ARCHIVE_DIR);
      const mirrorMap = loadMirror(sid, cfg.mirrorDir || MIRROR_DIR);
      let archived = new Map([...mirrorMap, ...archiveMap]);
      if (archived.size === 0) {
        archived = loadSessionLog(sid);
        if (archived.size) log('无归档/镜像，改用会话日志兜底（' + archived.size + ' 条）');
      }
      if (archived.size === 0) { log('既无归档/镜像，也读不到会话日志，不裁'); return next(); }

      const order = [...session.surface.nodes];
      const hasToolCallEvents = order.some((s) => session.eventAt(s)?.type === 'tool/call');
      const turns = buildTurns(nodes);
      const today = dayOf(Date.now());
      // 门牌窗口：停手水位 ÷ 日均新增，2~7 天
      const perDay = {};
      for (const nn of nodes) {
        const d = dayOf(nn.time);
        if (d === today) continue;
        perDay[d] = (perDay[d] ?? 0) + Math.round(charLen(session.deriveEventMessage?.(nn.event)) / 2);
      }
      const pastDays = Object.values(perDay).slice(-7);
      const avgDaily = pastDays.length ? Math.round(pastDays.reduce((a, b) => a + b, 0) / pastDays.length) : 0;
      const winDays = plateWindowDays(keepTokens, avgDaily);
      const cutoffDay = dayOf(Date.now() - (winDays - 1) * 86400e3);
      const isPlate = (seq) => isPlaceholder(session.deriveEventMessage?.(session.eventAt(seq)));
      // —— 摘要覆盖保护（）——
      // 只在「摘要块」覆盖到的位置之前裁；摘要本身和它之后的轮次不动，
      // 防「新轮次把摘要顶出保护名单」和「没进摘要的轮次被裁掉」造成的记忆断层。
      // 有摘要时只保留最近两轮（摘要+门牌），没有就按常规保留
      const keepTurnsNow = summarySeq ? 2 : cfg.keepTurns
      // 有摘要时不按保留线停手：摘要之前的全部裁掉
      const keepTokensNow = summarySeq ? 0 : keepTokens

      // 按 token 预算挑：从最早一轮往后累加，剩到 KEEP_TOKENS 就停（今天的内容也能切到它该切的地方）
      const spans = pickBudgetSpans(turns, {
        tokens,
        archived: (s) => archived.get(s),
        keepTurns: keepTurnsNow,
        keepTokens: keepTokensNow,
        isPlate,
        shadowOf: (t) => {
          let ch = 0;
          for (const seq of t.seqs) ch += charLen(session.deriveEventMessage?.(session.eventAt(seq)));
          return Math.round(ch / 2);
        },
      });
      // 窗口外的更早日合并成一行，不逐天堆门牌
      const older = [], recent = [];
      for (const s of spans) (s.day < cutoffDay ? older : recent).push(s);
      if (older.length) {
        recent.unshift({
          day: older[0].day, startSeq: older[0].startSeq, endSeq: older[older.length - 1].endSeq,
          count: older.reduce((a, s) => a + s.count, 0), seqs: older.flatMap((s) => s.seqs),
          days: new Set(older.map((s) => s.day)).size, meta: true,
        });
      }
      spans.length = 0; spans.push(...recent);
      // 摘要之后（含摘要本身）的段一律不裁
      if (summarySeq) {
        const before = spans.length
        for (let i = spans.length - 1; i >= 0; i--) if (!(spans[i].endSeq < summarySeq)) spans.splice(i, 1)
        if (spans.length !== before) log('摘要保护：只裁 seq<' + summarySeq + '，跳过 ' + (before - spans.length) + ' 段')
        if (spans.length === 0) { log('摘要之后没有可裁段，等下次摘要'); return next() }
      };
      const covered = turns.filter((t) => !t.seqs.some((s) => !archived.get(s)));
      log('上下文 ' + tokens + ' token，节点 ' + nodes.length + '，轮 ' + turns.length +
        '（覆盖 ' + covered.length + '），可裁段 ' + spans.length +
        '，窗口 ' + winDays + ' 天（日均 ' + avgDaily + '），保留线 ' + keepTokensNow +
        (turns[0] ? '，首轮 ' + turns[0].day + '#' + turns[0].startSeq : ''));
      // 压缩把门牌吞了 → 补一行索引块（只列最近窗口内的日子）
      if (ends > (c.indexEnds ?? 0)) {
        const daysSet = new Set();
        for (const v of archived.values()) if (v.day >= cutoffDay) daysSet.add(v.day);
        const list = [...daysSet].sort();
        c.indexEnds = ends;
        try { fs.writeFileSync(CALIB_FILE, JSON.stringify(calib)); } catch {}
        if (list.length) {
          const text = '[索引] 已归档并在归档/镜像里有原文的日期：' + list.map((d) => prettyDay(d)).join('、') +
            '（原文在归档文件里，按 seq 区间翻；插件读不到原文时不要裁）';
          const blocks = [{ type: 'text', text }];
          const src = { kind: 'user', rpcId: 'prune-index' };
          const message = createUserMessage ? createUserMessage({ content: blocks, source: src })
            : freezeMessage({ role: 'user', content: blocks, source: src });
          if (!DRY) session.append('user/message', message);
          log('压缩后补索引块，日期 ' + list.join(','));
        }
      }

      if (spans.length === 0) return next();

      let saved = 0, n = 0, failCount = 0;
      for (const span of spans) {
        if (tokens - saved <= keepTokensNow) break;
        // 收尾对齐：从后往前找最近的平衡点，切不干净就少裁几轮（多出来的留在面上）
        let cut = span.seqs.length - 1;
        while (cut > 0 && !balancedUpTo(order, session, span.seqs[cut], hasToolCallEvents)) cut--;
        if (cut <= 0) { log('找不到平衡切点，跳过 ' + span.startSeq + '-' + span.endSeq); continue; }
        let spanSeqs = span.seqs.slice(0, cut + 1);
        // 摘要块不进门牌：既不计数，也不扩进区间
        const summaryInSpan = spanSeqs.filter((s) => {
          const ev = session.eventAt(s)
          return ev?.type === 'user/message' && SUMMARY_MARK.test(messageText(session.deriveEventMessage?.(ev)).trim())
        })
        if (summaryInSpan.length) {
          log('区间含摘要块，剔除 ' + summaryInSpan.length + ' 个节点')
          spanSeqs = spanSeqs.filter((s) => !summaryInSpan.includes(s))
          if (!spanSeqs.length) continue
        }
        const endSeq = spanSeqs[spanSeqs.length - 1];
        let chars = 0, shadow = 0;
        for (const seq of spanSeqs) {
          const ev = session.eventAt(seq);
          const m = session.deriveEventMessage?.(ev);
          chars += charLen(m);
          shadow += Math.round(charLen(m) / 2);
        }
        if (chars < 200) continue;
        // 如果紧前面就是同一天的门牌，把它一起替换掉，重写成一条累计的门牌
        let replaceStart = span.startSeq;
        let prevPlate = null;
        if (!span.meta) {
          const i0 = order.indexOf(span.startSeq);
          // 往前最多看 4 个表面节点：中间夹着工具结果/助手回复也能合并，遇到别的天的门牌就停
          for (let k = 1; k <= 4 && i0 - k >= 0; k++) {
            const cand = order[i0 - k];
            const candEv = session.eventAt(cand);
            // 摘要块不是门牌，回看时直接跳过，避免把摘要塞进新门牌的区间里
            if (candEv?.type === 'user/message' && SUMMARY_MARK.test(messageText(session.deriveEventMessage?.(candEv)).trim())) continue;
            const pp = candEv?.type === 'user/message' ? parsePlate(session.deriveEventMessage?.(candEv)) : null;
            if (!pp) continue;
            if (pp.day !== span.day) break;
            prevPlate = { seq: cand, ...pp };
            replaceStart = cand;
            break;
          }
          // 合并区间里若有没归档的节点，就退回只裁本段（宁可少合并，不写坏日志）
          if (prevPlate) {
            const iA = order.indexOf(replaceStart);
            const iB = order.indexOf(endSeq);
            const bad = order.slice(iA, iB + 1).some((s) => {
              const m = session.deriveEventMessage?.(session.eventAt(s));
              return !archived.has(s) && !isPlaceholder(m) && !isLongText(m);
            });
            if (bad) { log('合并区间含未归档节点，退回单段 ' + replaceStart); prevPlate = null; replaceStart = span.startSeq; }
          }
        }
        const iStart = order.indexOf(replaceStart);
        const okStart = iStart <= 0 ? true : balancedUpTo(order, session, order[iStart - 1], hasToolCallEvents);
        if (!okStart) { log('起点不平整，跳过 ' + replaceStart); continue; }
        // 收集本段里的长文落盘标记，跟门牌一起留一行，裁切后还能找回
        const ltList = [];
        const iEnd = Math.max(iStart, order.indexOf(endSeq));
        for (const s of order.slice(iStart, iEnd + 1)) {
          const m = session.deriveEventMessage?.(session.eventAt(s));
          if (!isLongText(m)) continue;
          const blocks = m?.content;
          const raw = Array.isArray(blocks)
            ? blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n')
            : (typeof blocks === 'string' ? blocks : '');
          const line = raw.trim().split('\n')[0].slice(0, 160);
          if (line && !ltList.includes(line)) ltList.push(line);
        }
        const text = span.meta
          ? META_PLACEHOLDER(span.days ?? 1, span.count, sid)
          : DAY_PLACEHOLDER(
              span.day,
              (prevPlate?.count ?? 0) + spanSeqs.length,
              prevPlate?.file ?? archived.get(span.startSeq).file,
              sid,
              Math.min(prevPlate?.start ?? span.startSeq, span.startSeq),
              Math.max(prevPlate?.end ?? endSeq, endSeq),
              ltList.slice(0, 5),
            );
        if (DRY) {
          log('DRY 会裁 ' + prettyDay(span.day) + ' seq ' + span.startSeq + '-' + span.endSeq + '（' + chars + ' 字）');
          saved += shadow; n++;
          continue;
        }
        const blocks = [{ type: 'text', text }];
        const src = { kind: 'user', rpcId: 'prune-' + span.startSeq + '-' + endSeq };
        const message = buildUserMessage(blocks, src);
        const key = sid + ':' + replaceStart + '-' + endSeq;
        if (done.has(key)) { log('这段已经裁过，跳过 ' + key); continue; }
        // 区间列表就是当前运行时表面的一段（核心自动维护，不信自己重放的）
        const _iA = order.indexOf(replaceStart), _iB = order.indexOf(endSeq);
        if (_iA < 0 || _iB < _iA) {
          log('区间端点不在当前表面，跳过 ' + replaceStart + '-' + endSeq);
          continue;
        }
        const replayGuess = replaySurfaceSpan((s) => session.eventAt(s), replaceStart, endSeq);
        if (replayGuess && (replayGuess.length !== _iB - _iA + 1 ||
            replayGuess.some((s, k) => s !== order[_iA + k]))) {
          log('重放与表面不一致（' + replaceStart + '-' + endSeq + '），以表面为准');
        }
        const exact = order.slice(_iA, _iB + 1);
        let eChars = 0, eShadow = 0;
        for (const seq of exact) {
          const m = session.deriveEventMessage?.(session.eventAt(seq));
          eChars += charLen(m);
          eShadow += Math.round(charLen(m) / 2);
        }
        if (eChars < 200) { log('精确区间太短，跳过 ' + replaceStart + '-' + endSeq); continue; }
        // 影子价格协议：compaction/prune 紧挨在替换事件前面。
        // 替换被拒就会留下孤儿 prune，所以失败立刻停手，别连着重试
        try {
          session.append('compaction/prune', {
            shadowedRange: { start: replaceStart, end: endSeq },
            shadowedSeqs: exact,
            shadowedTokenCount: eShadow,
          });
          session.append('user/message', message, {
            surfaceOp: { op: 'replace', startSeq: replaceStart, endSeq },
            sourceEventSeqs: exact,
          });
        } catch (e) {
          failCount++;
          log('写入被核心拒绝（第 ' + failCount + ' 次）：' + replaceStart + '-' + endSeq + '：' + (e?.message ?? e));
          if (failCount >= 3) {
            tripFuse(sid, '核心连续拒绝写入门牌替换：' + (e?.message ?? e));
            log('连续失败，已熔断本会话：' + sid + '（名单 ' + FUSE_FILE + '）');
            try {
              const notice = buildUserMessage([{ type: 'text', text: '【日志裁切熔断】本会话裁切已被禁用：核心连续三次拒绝写入门牌替换（' + (e?.message ?? e) + '）。请检查 ' + FUSE_FILE + '，修好后删掉这个会话的条目再重启。' }], { kind: 'user', rpcId: 'prune-fuse-' + Date.now() });
              if (notice) session.append('user/message', notice);
            } catch (e2) { log('熔断提示写入失败：' + (e2?.message ?? e2)); }
            break;
          }
          continue;
        }
        done.add(key);
        saved += eShadow; n++;
        // 交接：把裁掉的这段交给别的插件（默认关）——
        // 归档里本来就有原文，这里主要是给「提炼日记/摘要」这类消费方送一份现成的
        if (cfg.handoffEnabled) {
          try {
            const 文本 = exact.map((s) => messageText(session.deriveEventMessage?.(session.eventAt(s)))).join(String.fromCharCode(10)).slice(0, 400000)
            const 门牌 = exact.filter((s) => isPlaceholder(session.deriveEventMessage?.(session.eventAt(s)))).map((s) => String(s))
            deliver(ctx, log, cfg, { sid, from: replaceStart, to: endSeq, seqs: exact, text: 文本, plates: 门牌 })
          } catch (e) { log('交接失败：' + (e?.message ?? e)) }
        }
      }
      if (n) log('裁了 ' + n + ' 段，省约 ' + saved + ' token（' + (DRY ? 'DRY' : '当前 ' + tokens + '）'));
    } catch (e) {
      log('跳过（' + (e?.message ?? e) + '）');
    }
    return next();
  };
  ctx.on('agent/pre-step', pruneStep);
  // 摘要写入后立刻裁一次：不等下一轮，省掉一次 40 万级冷读（默认关，测试通过再开）
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    try {
      if (!agent?.session) return;
      const text = JSON.stringify(message?.content ?? message ?? '');
      if (!/裁切摘要/.test(text)) return;
      if (!pruneAfterSummaryEnabled(agent.session.id)) return;
      void pruneStep({ agent }, async () => {});
    } catch {}
  });
}