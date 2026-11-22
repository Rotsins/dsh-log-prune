#!/usr/bin/env node
// archive-sessions.mjs —— 把会话日志按天切片存成归档包（一手层副本，只读不删）
// 用法：
//   node archive-sessions.mjs [--dry]
//   node archive-sessions.mjs --sid <id> --from <A> --to <B>  补洞：忽略水位，把区间内归档未覆盖的事件补进去
// 产物：<DSH_HOME>/记忆/日志存档/<YYYYMMDD>_<sid>.日志（zstd 帧拼接）
// 水位：<DSH_HOME>/state/archive-watermark.json（每个会话已归档到的 seq）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolveHome } from '../lib/home.mjs';
import { writeJsonAtomic } from '../lib/atomic.mjs';

// 2026-11-19 Windows 兼容版：DSH_HOME → C:\data\dsh → ~/.dsh 按 sessions/state/profiles 探测
// B7：与插件/工具箱共用同一套探测，避免离线工具扫到 0 个会话
const HOME = resolveHome();
const SESS = path.join(HOME, 'sessions');
const OUT = path.join(HOME, '记忆/日志存档');
const WM = path.join(HOME, 'state/archive-watermark.json');
const dry = process.argv.includes('--dry');
const INDEX_DIR = process.env.DSH_LOG_PRUNE_INDEXDIR || path.join(HOME, 'state', 'prune-index');
let plainWriter = null;
const plainCands = [process.env.DSH_PLAIN_MODULE, path.join(HOME, 'plugins', 'dsh-log-prune', 'lib', 'plain.mjs')].filter(Boolean);
for (const c of plainCands) {
  try { const { makeWriter } = await import(pathToFileURL(c).href); plainWriter = makeWriter(INDEX_DIR); break; } catch {}
}

// 检索层按会话取配置：补归档也遵守面板「保存到当前会话」的 plain* 设置。
// 读不到配置就跳过明文索引（不回落 90天/2万字默认值去误写或误删）。
let 会话检索配置 = null;
try {
  const cfgPath = process.env.DSH_LOG_PRUNE_CONFIG || path.join(HOME, 'state', 'log-prune.yml');
  if (!fs.existsSync(cfgPath)) throw new Error('找不到 ' + cfgPath);
  process.env.DSH_LOG_PRUNE_CONFIG = cfgPath;
  process.env.DSH_LOG_PRUNE_SESSIONS = process.env.DSH_LOG_PRUNE_SESSIONS || path.join(HOME, 'state', 'log-prune-sessions.json');
  const m = await import(new URL('../lib/config.mjs', import.meta.url).href);
  if (typeof m.effectiveConfig !== 'function') throw new Error('config.mjs 没有导出 effectiveConfig');
  会话检索配置 = m.effectiveConfig;
} catch (e) {
  console.error('[archive-sessions] 检索配置不可用，跳过明文索引写入（不按默认值误写/误删）：' + (e?.message ?? e));
}

// S1：压缩/解压统一走 zstd-safe（原来的三路兜底探测已删除，能力探测见 log-prune/lib/capabilities.mjs）
import { compressZstd as safeCompress, unzstd as safeUnzstd } from '../lib/zstd-safe.mjs'
import { sessionFileName } from '../lib/session-file.mjs'
function compressZstd(buf) { return safeCompress(buf) }
function decompressSessionFile(f) { return safeUnzstd(fs.readFileSync(f)).toString('utf8') }
const textOf = (e) => {
  const c = e?.data?.content ?? e?.data?.message?.content ?? e?.data?.text;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b && typeof b.text === 'string').map((b) => b.text).join('\n');
  return '';
};
const argOf = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const onlySid = argOf('--sid') || '';
const fillFrom = argOf('--from') != null ? Number(argOf('--from')) : null;
const fillTo = argOf('--to') != null ? Number(argOf('--to')) : null;
const fillMode = fillFrom != null && fillTo != null && Number.isFinite(fillFrom) && Number.isFinite(fillTo) && fillTo >= fillFrom;

fs.mkdirSync(OUT, { recursive: true });
const wm = fs.existsSync(WM) ? JSON.parse(fs.readFileSync(WM, 'utf8')) : {};
const TZ = (() => { const s = process.env.DSH_TZ || 'Asia/Shanghai'; try { new Intl.DateTimeFormat('en-CA', { timeZone: s }).format(0); return s } catch { return 'Asia/Shanghai' } })();
const dayOf = (t) => new Date(t).toLocaleDateString('sv-SE', { timeZone: TZ }).replaceAll('-', '');

function listLogs(dir) {
  const out = [];
  for (const ws of fs.readdirSync(dir)) {
    const wsDir = path.join(dir, ws);
    if (!fs.statSync(wsDir).isDirectory()) continue;
    for (const s of fs.readdirSync(wsDir)) {
      const f = path.join(wsDir, s, sessionFileName(path.join(wsDir, s)));
      if (fs.existsSync(f)) out.push(f);
    }
  }
  return out;
}

// 补洞模式：合并该会话所有归档文件的 ranges，得到已覆盖 seq 集合
function archivedCovered(sid) {
  const covered = new Set();
  try {
    for (const f of fs.readdirSync(OUT)) {
      if (!f.endsWith('_' + sid + '.日志')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(OUT, f + '.seqs.json'), 'utf8'));
        for (const r of j.ranges || []) if (Array.isArray(r) && r.length >= 2) for (let x = Number(r[0]); x <= Number(r[1]); x++) covered.add(x);
      } catch {}
    }
  } catch {}
  return covered;
}

const report = { files: 0, lines: 0, skipped: 0, batches: [] };

// 2026-11-19：归档前剥掉 assistant/message 的 data.stream（服务器流式原始帧，占文件大头），
// 只保留 message.content；门牌/prune 等过滤方案待定，不在此处理。
// B9：只剥「非空数组」的 stream——F2 置空后 stream: [] 是合法形态，别再删成 undefined。
// （将来若把会话路径接回本脚本的 cleanEvent，也不会破坏置空结果。）
function cleanEvent(e) {
  if (!e || e.type !== 'assistant/message') return e
  const d = e.data
  if (!d || !Array.isArray(d.stream) || d.stream.length === 0) return e
  const c = { ...e, data: { ...d } }
  delete c.data.stream
  return c
}

function appendBatch(day, sid, evts) {
  evts = evts.map(cleanEvent)
  const dest = path.join(OUT, day + '_' + sid + '.日志');
  report.files++; report.lines += evts.length;
  report.batches.push({ sid, day, from: evts[0].seq, to: evts.at(-1).seq, n: evts.length, fill: fillMode });
  if (dry) return;
  const CHUNK = Number(process.env.DSH_ARCHIVE_FRAME || 500);
  const side = dest + '.frames.jsonl';
  const ranges = [];
  for (let i = 0; i < evts.length; i += CHUNK) {
    const part = evts.slice(i, i + CHUNK);
    const body = part.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const chunk = compressZstd(body);
    let off = 0;
    try { off = fs.statSync(dest).size } catch {}
    if (off) fs.appendFileSync(dest, chunk); else fs.writeFileSync(dest, chunk);
    try {
      fs.appendFileSync(side, JSON.stringify({ off, len: chunk.length, from: part[0].seq, to: part[part.length - 1].seq, n: part.length, at: Date.now() }) + '\n');
    } catch (e) {
      // B1 源头：侧车写失败原本静默——帧索引从此对不上文件，cleanArchiveStreams 的完整性核对
      // 会把整份归档判为 sidecar incomplete 而拒绝重写。至少喊一声。
      console.error('[archive-sessions] 侧车写入失败（' + dest + '）：' + (e?.message ?? e));
    }
    ranges.push([part[0].seq, part[part.length - 1].seq, part.length]);
  }
  if (ranges.length) {
    try {
      const sq = dest + '.seqs.json';
      let old = [];
      try { old = JSON.parse(fs.readFileSync(sq, 'utf8')).ranges || []; } catch {}
      let complete = false;
      try {
        let flen = 0;
        for (const line of fs.readFileSync(side, 'utf8').split('\n')) {
          if (!line) continue;
          try { flen += JSON.parse(line).len || 0; } catch {}
        }
        complete = flen === fs.statSync(dest).size;
      } catch {}
      fs.writeFileSync(sq, JSON.stringify({ ranges: old.concat(ranges), complete, at: Date.now() }));
    } catch {}
  }
  if (plainWriter) {
    const pc = 会话检索配置 ? 会话检索配置(sid) : null;
    if (!pc) {
      report.warnings = report.warnings || [];
      report.warnings.push({ sid, day, skipped: '检索配置不可用' });
    } else {
      try {
        const ents = [];
        for (const e of evts) {
          const t = textOf(e);
          if (!t.trim()) continue;
          ents.push({ seq: e.seq, time: e.time || Date.now(), role: e.data?.message?.role || e.type || '?', type: e.type || '', text: t, arch: dest });
        }
        const nIdx = plainWriter(sid, () => day, ents, { maxChars: pc.plainMaxChars, keepDays: pc.plainKeepDays, idxKeepDays: pc.idxKeepDays, redact: pc.plainRedact, plainEnabled: pc.plainEnabled });
        if (nIdx) report.batches.push({ sid, day, indexed: nIdx });
      } catch {}
    }
  }
}

for (const f of listLogs(SESS)) {
  const text = decompressSessionFile(f);
  const lines = text.split('\n').filter(Boolean);
  const head = JSON.parse(lines[0]);
  const sid = head.id;
  if (onlySid && sid !== onlySid) continue;
  let evts = [];
  if (fillMode) {
    const covered = archivedCovered(sid);
    for (const line of lines.slice(1)) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (typeof e.seq === 'number' && e.seq >= fillFrom && e.seq <= fillTo && !covered.has(e.seq)) evts.push(e);
    }
  } else {
    const last = wm[sid] ?? -1;
    for (const line of lines.slice(1)) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (typeof e.seq === 'number' && e.seq > last) evts.push(e);
    }
  }
  if (evts.length === 0) {
    // fill 模式下区间已全覆盖，也要把水位推到位（ensureArchived 靠它判断）
    if (!dry && fillMode) wm[sid] = Math.max(wm[sid] ?? -1, fillTo)
    report.skipped++
    continue
  }

  const byDay = new Map();
  for (const e of evts) {
    const d = dayOf(e.time);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(e);
  }
  if (!fillMode && (wm[sid] ?? -1) === -1) {
    const first = [...byDay.keys()][0];
    byDay.get(first).unshift({ ...head, seq: -1 });
  }
  for (const [day, list] of byDay) appendBatch(day, sid, list);
  // 2026-11-19：fill 补洞后也要推进水位，否则 ensureArchived 的 watermark 检查永远不过
  if (!dry) wm[sid] = Math.max(wm[sid] ?? -1, fillMode ? fillTo : evts.at(-1).seq);
}
if (!dry) { try { writeJsonAtomic(WM, wm, 2) } catch (e) { console.error('水位写回失败：' + (e?.message ?? e)); process.exitCode = 3 } }
console.log(JSON.stringify({ files: report.files, lines: report.lines, skipped: report.skipped, fill: fillMode ? { from: fillFrom, to: fillTo } : null, sample: report.batches.slice(0, 3) }, null, 2));