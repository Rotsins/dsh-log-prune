// dsh-log-prune —— 按 token 预算裁切：从最早一轮往后累加，剩到「保留线」就停，裁掉的段换成一行日期门牌
// 口径：只改工作台视图，不删日志；每个节点必须已经进镜像/归档；最近的轮次不动；出错一律不裁
// 替换方式对齐官方 compaction：compaction/prune + user/message(surfaceOp replace start..end)
export const name = 'log-prune';
// C2（2026-11-19）：工具箱是裁切的硬前置（不装没有配置面板）。显式声明为依赖，由宿主保证
// 加载顺序；缺失时本插件 fail-fast 不激活（见 apply 内），绝不静默降级解压。
export const inject = ['webServer', 'agents', 'tools', 'toolbox'];

import fs from 'node:fs';
import fsp from 'node:fs/promises'; // M2：readPlainTexts 真异步读
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fromHostTree } from './hostdeps.mjs';
import { loadConfig, ensureConfigFile, saveConfig, CONFIG_PATH, effectiveConfig, loadSessions, setSessionOverride, clearSessionOverride, GLOBAL_KEYS } from './config.mjs';
import { startWatcher } from './watcher.mjs';
import { sessionFileName } from './session-file.mjs';
import { decompress as vendorFzstdDecompress } from './vendor/fzstd.mjs';
// 修复能力统一由 dsh-toolbox 提供（服务名 toolbox）；本插件不再自带 repair.mjs
let TB = null
// 解压能力由工具箱提供（fzstd 只留工具箱一份）；worker 线程用路径
let fzstdDecompress = vendorFzstdDecompress
let fzstdVendorPath = ''
function tb() { if (!TB) throw new Error('dsh-toolbox 未就绪（修复能力由工具箱提供）'); return TB }
function repairOrphans(...a) { return tb().repairOrphans(...a) }
function checkSession(...a) { return tb().checkSession(...a) }
import { tryLock, releaseLock } from './lock.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deliver } from './handoff.mjs';
import { makeWriter, grepIndex, readText } from './plain.mjs';
import { resolveHome } from './home.mjs';
import { hostCompatible, compareLoose } from './semver.mjs';
import { nodeRequirement } from './node-guard.mjs';
import { systemdRunArgs } from './procctl.mjs';
import { getTimeZone, isValidTimeZone } from './tz.mjs';
import { checkCapabilities } from './capabilities.mjs';
import { dayKey, readLastClean, writeLastClean, decideDailyClean, claimDay, dayClaimPath, minutesOfDayBJ } from './offclean-day.mjs';
import { charLen, messageText } from './msgtext.mjs';
import { PLATE_MERGE, decidePlateMerge, parsePlate, mergePlateChain, plateWindowDays, ARCHIVE_RE, isPlaceholder, isLongText } from './plate.mjs';
export { decidePlateMerge, parsePlate, mergePlateChain, plateWindowDays, ARCHIVE_RE, isPlaceholder, isLongText } from './plate.mjs';
import { replaySurfaceSpan, buildTurns, pickDaySpans, pickBudgetSpans, selectCutSpans, pickTargets, balancedUpTo } from './turns.mjs';
export { replaySurfaceSpan, buildTurns, pickDaySpans, pickBudgetSpans, selectCutSpans, pickTargets, balancedUpTo } from './turns.mjs';
import { SeqRanges, ArchiveView } from './archive.mjs';
export { SeqRanges, ArchiveView } from './archive.mjs';
import { setZstd, readZstd, readArchiveTexts, loadArchive, loadSessionLog, loadMirror } from './archive.mjs';
export { loadArchive, loadSessionLog, loadMirror } from './archive.mjs';
import { ensureArchived } from './ensure-archive.mjs';
import { cleanArchiveStreams, requestRestart } from './archive-clean.mjs';
import { VERSION } from './version.mjs';
import { analyzeSessionVolume } from './volume.mjs';   // O5 体积分析
import zlib from 'node:zlib';

// Q1：Node 20 / 22.14 没有 zstdDecompressSync，命名导入会让整条插件在加载阶段就抛错。
// 改成默认导入再解构，拿不到就是 undefined，readZstd 里的 typeof 保护才来得及生效。
const { zstdDecompressSync } = zlib;

const HOME = resolveHome();
// 锁定会话列表（两个插件共用这一个文件；浏览器 localStorage 仍是主，这里落盘一份）
const LOCK_FILE = path.join(HOME, 'state', 'locked-sessions.json')

// 日志时间统一写本地时间（UTC+8）（S3：实现收口到 lib/util.mjs）
import { tsLocal } from './util.mjs'

// —— Q18：请求守卫（2026-11-16）——
// 宿主只对页面本身做认证，插件用 webServer.register 注册的路由不经过它（实测未登录 GET /config 直接 200）。
// 两层：
//   1) 谁在连：回环放行；非回环默认拒绝，allowRemote=true 时才要求 x-lp-token
//   2) 谁的浏览器在发：写操作强制 application/json + Origin 同源（防 CSRF）
// 桌面端和本机 web 的 remoteAddress 都是回环，所以不需要单独探测环境；IS_DESKTOP 只用于日志。
const IS_DESKTOP = !!(process.versions.electron || /[\\/]resources[\\/]|[\\/]app\.asar/.test(process.execPath || ''));

let _lpToken = null;
function lpToken() { return _lpToken || (_lpToken = loadOrCreateToken()); }
function loadOrCreateToken() {
  const file = path.join(HOME, 'state/access-token.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 正则校验：文件被手工改坏时别把非法字符注入到页面 script 里
    if (j && typeof j.token === 'string' && /^[0-9a-f]{32,}$/.test(j.token)) return j.token;
  } catch {}
  const token = randomUUID().replace(/-/g, '');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ token, at: Date.now() }), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch {}
    // L4：Windows / CIFS / NFS 上 mode 可能无效；不是 0600 就提示一次（token 只建一次）
    try {
      const mode = fs.statSync(file).mode & 0o777;
      if (mode !== 0o600) console.warn('[log-prune] token 文件权限为 ' + mode.toString(8) + '（非 0600）：该文件系统可能不支持 mode，allowRemote 请只开在受信网络')
    } catch {}
  } catch {}
  return token;
}

// 2026-11-21：cookie 也作为 token 来源（与工具箱同一个 dsh_tb_token）。
// 面板带 ?token= 打开成功后种 HttpOnly cookie 并 302 去掉地址栏参数，
// 刷新/同源 fetch 靠 cookie 即可，token 不再进历史与 Referer。
function cookieToken(req) {
  const c = String((req.headers && req.headers.cookie) || '')
  const m = /(?:^|;\s*)dsh_tb_token=([^;]+)/.exec(c)
  return m ? decodeURIComponent(m[1]) : ''
}
function tokenOk(req) {
  const want = lpToken()
  const got = String((req.headers && req.headers['x-lp-token']) || '') || cookieToken(req)
  return !!(got && got === want)
}
function setTokenCookie(res, token) {
  try { res.setHeader('set-cookie', 'dsh_tb_token=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000') } catch {}
}

function isLoopback(req) {
  const ip = req.socket?.remoteAddress || '';
  if (!ip) return true; // unix socket / 无地址，视为本机
  return /^(127\.|::1$|::ffff:127\.)/.test(ip);
}
// 2026-11-21：Tailscale serve / 本机反代下 socket 是回环，但 XFF 带的是 tailnet 客户端（100.64/10）。
// 取 XFF 的最后一跳（由最近的反代追加，客户端无法伪造这一项），只把 tailnet 与回环当作本机；
// 公网 IP 仍按远程走 allowRemote + token。
function xffLast(req) {
  const parts = String((req.headers && req.headers['x-forwarded-for']) || '').split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}
function isTrustedClientIP(ip) {
  if (!ip) return false;
  if (/^(127\.|::1$|::ffff:127\.)/.test(ip)) return true;
  if (/^100\./.test(ip)) { const o = Number(ip.split('.')[1]); return o >= 64 && o <= 127; }
  return false;
}
function isLocalHostname(h) {
  return /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(String(h || ''));
}
function isWrite(method) {
  const m = String(method || 'GET').toUpperCase();
  return m === 'POST' || m === 'PUT' || m === 'DELETE' || m === 'PATCH';
}
function deny(res, msg) {
  try {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: msg }));
  } catch {}
  return false;
}
// 返回 '' 表示通过，否则是拒绝原因
function checkOrigin(req) {
  const origin = req.headers.origin;
  const host = String(req.headers.host || '');
  if (!origin) return ''; // curl、脚本、插件内部调用
  if (origin === 'null' || origin.startsWith('file://')) return ''; // 桌面端页面
  try {
    const o = new URL(origin);
    if (o.host === host) return '';
    // 127.0.0.1 与 localhost 互换也算同源（端口必须一致）
    if (isLocalHostname(o.hostname) && isLocalHostname(new URL('http://' + host).hostname)) {
      if (o.port === new URL('http://' + host).port) return '';
    }
  } catch {}
  return '跨站请求已拒绝（Origin 校验失败）';
}
// F3（2026-11-21）：默认不信任 X-Forwarded-For —— 直连部署下这个头完全由客户端伪造，
// 带一个 '100.64.1.1' 就能冒充 tailnet 本机，绕过 allowRemote/token 和写操作 CSRF。
// 只有确认前面挂了一层会覆盖该头的反代时才开：log-prune.yml trustProxy: true 或 DSH_TRUST_PROXY=1。
function trustedProxyOn(cfg) {
  if (process.env.DSH_TRUST_PROXY === '0') return false // 显式关闭，便于测试/临时排障
  return process.env.DSH_TRUST_PROXY === '1' || !!(cfg && cfg.trustProxy)
}
// 写操作防线单独成函数：原来 XFF 分支整段跳过它，现在三条路径共用
function writeOk(req, res) {
  if (!isWrite(req.method)) return true
  // 强制 JSON：sandbox iframe / form / no-cors fetch 只能发简单请求（三种 Content-Type），
  // 要发 application/json 必须先过 preflight，而我们不返回任何 CORS 头 ⇒ 请求根本发不出来。
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) {
    return deny(res, '只接受 application/json')
  }
  const why = checkOrigin(req)
  if (why) return deny(res, why)
  return true
}
function guard(req, res, cfg) {
  const xff = req.headers && req.headers['x-forwarded-for']
  // 只有 TCP 对端本身是回环（本机 nginx / tailscale serve）时才认 XFF。
  // 公网直连即使伪造 X-Forwarded-For: 100.64.x.x，也按远程走 allowRemote + token。
  if (trustedProxyOn(cfg) && xff && String(xff).trim() && isLoopback(req)) {
    if (isTrustedClientIP(xffLast(req))) return writeOk(req, res) // tailnet / 本机反代：仍过 CSRF 防线
    if (!cfg.allowRemote) return deny(res, '检测到反向代理头，按远程访问处理；请设 allowRemote: true 并带 x-lp-token')
    lpToken() // 先确保 token 文件已生成，用户才知道该带什么
    if (tokenOk(req)) return writeOk(req, res)
    return deny(res, '缺少或错误的 x-lp-token')
  }
  if (!isLoopback(req)) {
    if (!cfg.allowRemote) return deny(res, '非本机访问已拒绝：如需远程访问，请在配置里设 allowRemote: true');
    lpToken(); // 同上：先落 token 文件
    if (tokenOk(req)) return writeOk(req, res);
    return deny(res, '缺少或错误的 x-lp-token');
  }
  return writeOk(req, res);
}

// —— 阈值：单一口径（O2，2026-11-16）——
// 以前这里另有一套常量（各自读环境变量），主链路却走 cfg.*，导致「环境变量改了只在日志里生效」。
// 现在启动时从配置读一次：环境变量 → log-prune.yml → DEFAULTS，三处只认一个来源。
// 换预设或改 thresholdRatio 之后，仍然请同步 compactPoint（否则裁切线和官方压缩线会错位）。
const _boot = loadConfig();
const KEEP_TURNS = _boot.keepTurns;
const COMPACT_POINT = _boot.compactPoint;
const TRIGGER_RATIO = _boot.triggerRatio;
const KEEP_TOKENS = _boot.keepTokens;
const SUMMARY_POINT = _boot.summaryPoint;
const LONGTEXT_ROOT = process.env.DSH_LOG_PRUNE_LONGTEXT_DIR ?? path.join(HOME, 'inbox', 'longtext');
const LT_STATE_DIR = path.join(HOME, 'state', 'longtext');
// 状态文件读写已抽到 ./state.mjs（5.2 拆分）：熔断名单/裁切状态/校准/通用 JSON
import { FUSE_FILE, CALIB_FILE, readFuse, tripFuse, readStatus, writeStatus, orphanOf, clearOrphanRisk, clearFuse, readStateFile } from './state.mjs';

const TOK_DIR = process.env.DSH_LOG_PRUNE_TOKDIR ?? path.join(HOME, 'state', 'prune-tokens');
// 2026-11-17 管理员定「只留摘要」：watcher 派发摘要时上弦，收到下一条消息时按摘要位置裁一刀
const ARMED_DIR = process.env.DSH_LOG_PRUNE_ARMEDDIR ?? path.join(HOME, 'state', 'prune-armed');
const ARCHIVE_DIR = process.env.DSH_LOG_ARCHIVE ?? path.join(HOME, '记忆', '日志存档');
const MIRROR_DIR = process.env.DSH_LOG_MIRROR ?? path.join(HOME, '记忆', '镜像');
// 裁切内容轻索引（检索用）：独立目录，不放进 记忆/*（会被 seal/归档脚本搬动或压缩）
const PLAIN_INDEX_DIR = process.env.DSH_LOG_PRUNE_INDEXDIR ?? path.join(HOME, 'state', 'prune-index');
const plainWriter = makeWriter(PLAIN_INDEX_DIR);
// Windows 上 spawn 必须隐藏窗口（否则每读一次归档闪一次 cmd），并且只探测一次


// O1：大文件（>=8MB）的解压 + 解析交给 worker 线程，主线程不再被卡住。
// 实测（59MB 会话文件 / 158MB 解压后）：同步 5.6 秒整段阻塞；worker 约 20 秒但主线程完全空闲
// （期间主线程 tick 261 次）。选 worker 是因为阻塞会拖住所有会话，而后台多花十几秒只是这条
// 兜底路径变慢——它只在「既没有归档也没有镜像」时才会走，且带 10 分钟缓存。
// worker 返回 [seq, time] 元组（回传 158MB 文本的结构化克隆本身就要十几秒）。


// B2（2026-11-17）：读原文的异步解压器 —— 大文件下放 worker（只回传命中正文），小文件同步抽；
// 按 file+mtime 缓存，已探测过的 seq 不再重复解压（归档日封后不可变）。


// 只留摘要当天裁的内容还没日封；日封后归档文件名就是「YYYYMMDD_<sid>.日志」。
// 按行时间直接算文件名，不去解压任何归档（loadArchive 全量解压会卡主线程）。
function archiveFileForDay(sid, t) {
  try {
    const dir = effectiveConfig(sid).archiveDir || ARCHIVE_DIR
    const f = path.join(dir, dayOf(t) + '_' + sid + '.日志')
    return fs.existsSync(f) ? f : ''
  } catch { return '' }
}

// B3：裁切时写的明文副本，当天就能读全文（优先于归档/首句回退）
function plainFileForDay(sid, t) {
  try {
    const f = path.join(PLAIN_INDEX_DIR, sid, dayOf(t) + '.txt')
    return fs.existsSync(f) ? f : ''
  } catch { return '' }
}

async function readPlainTexts(file, wantedSet) {
  const out = new Map()
  // M2：限长读（8MB）改用 fs/promises 真异步 —— 原实现虽标 async，内部全是 *Sync，
  // 仍会占住宿主事件循环；超出的部分由 readText 按 seq 读归档兜底。
  let raw = ''
  try {
    const st = await fsp.stat(file)
    const n = Math.min(st.size, 8 * 1024 * 1024)
    const fh = await fsp.open(file, 'r')
    try {
      const buf = Buffer.alloc(n)
      const { bytesRead } = await fh.read(buf, 0, n, 0)
      raw = buf.subarray(0, bytesRead).toString('utf8')
    } finally { await fh.close() }
  } catch { return out }
  for (const line of raw.split('\n')) {
    if (!line) continue
    let j
    try { j = JSON.parse(line) } catch { continue }
    if (typeof j.seq === 'number' && wantedSet.has(j.seq) && typeof j.text === 'string') out.set(j.seq, j.text)
  }
  return out
}



const DRY = process.env.DSH_LOG_PRUNE_DRY === '1';
// 旧门牌合并（2026-11-18）：默认关，先在副本/DRY 上验证再打开。

// O15：诊断日志默认静默；排查时设 DSH_LOG_PRUNE_DEBUG=1
const DEBUG = process.env.DSH_LOG_PRUNE_DEBUG === '1';
const CACHE_MS = 30000;

// 作息日口径：宿主有 lib/daycut.mjs 就用它，没有就用插件自带的那份
const _day = await (async () => {
  // P14：import() 要 URL/file 路径，用 path.join 拼再转 file URL（Windows 上直接拼 '/lib/...' 会混分隔符）
  // 2026-11-21 时区可配置：优先用插件自带的 daycut（读配置时区），宿主那份是固定 Asia/Shanghai 的旧口径
  try { return await import('./daycut.mjs') } catch { return await import(pathToFileURL(path.join(HOME, 'lib', 'daycut.mjs')).href) }
})();
const { dayOf, prettyDay } = _day;

export const DAY_PLACEHOLDER = (day, count, file, sid, a, b, longtexts = []) =>
  '[' + prettyDay(day) + ' 全天记录已归档 · ' + count + ' 条 · 原文 ' + file + ' · seq=' + a + '-' + b +
  ' · 找内容：log_prune_search("关键词")；取全文：log_prune_read(' + a + ',' + b + ')（编号以归档镜像为准，可能被外部清理工具重排）' +
  (longtexts.length ? '\n· 长文落盘 ' + longtexts.length + ' 篇：' + longtexts.join('；') : '') + ']';







export const META_PLACEHOLDER = (days, count, sid) =>
  '[更早的 ' + days + ' 天记录已归档 · ' + count + ' 条 · 会话 ' + String(sid || '').slice(0, 12) +
  ' · 找内容：log_prune_search("关键词")；取全文：log_prune_read(起,止)]';




// —— 摘要落地检测（2026-11-14 管理员定）——
// 派发摘要后，新摘要消息落进表面（seq 超过派发时的 lastSeq）才算落地；落地前不裁，
// 免得拿着旧摘要白跑一次。落地就立刻裁，不等下一轮对话。
const REQ_FILE = path.join(HOME, 'state', 'summary-requested.json');
const PRUNED_FILE = path.join(HOME, 'state', 'prune-last.json');
import { TASK_MARK, isSummaryText, scanIgnoredReply, scanSummarySeq } from './summary.mjs';
export { isSummaryText, scanIgnoredReply, scanSummarySeq } from './summary.mjs';

export { charLen } from './msgtext.mjs';

const SURFACE_EVENT_TYPES = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result']);

/**
 * 纯函数：按落盘日志的表面规则重放出 [startSeq, endSeq] 这段当前的表面节点。
 * 运行时 session.surface.nodes 并不等于磁盘重放的表面（会漏 system/message），
 * 所以替换区间必须自己重放算一遍，和恢复时的校验器用同一套规则。
 * 表面不自洽就返回 null —— 宁可不裁，也不写坏日志。
 */


/** 纯函数：把节点切成轮次（user/message 起头），给每轮打日期 */


/** 纯函数：旧口径（按天整段挑，已不再用于裁切，保留给单测） */


/**
 * 纯函数：按 token 预算裁切 —— 从最早一轮往后累加，剩到 keepTokens 就停。
 * 不再按天整段吞：预算落在某天中间时，只裁那天靠前的那部分（同一天的门牌会累计合并）。
 * shadowOf(turn) 返回该轮大概占多少 token；门牌本身和没进镜像/归档的轮次一律跳过。
 */


/**
 * 纯函数：挑选要裁的轮次（2026-11-16 抽出，为了能单测"摘要边界"这个坑）
 * 有摘要时边界就是摘要本身：候选轮只取「整轮都在摘要之前」的，且不做预算停手。
 * 之前用「预算不停手 + 事后过滤」，同一天的所有轮会被合并成一个 span，
 * 这个 span 的末尾必然越过摘要 → 事后整段被滤掉 → 一轮都裁不了。
 */


/** 纯函数：旧口径（逐条工具结果）——保留给单测 */



// O8：三处（probeSession / measureTokens / pruneStep）原来各扫一遍表面，合并成一个实现。
// 按「表面长度 + 首尾 seq」做版本号缓存：表面变了（追加/替换/压缩）就重算，没变直接复用。
const nodesCache = new WeakMap();
function collectNodes(session) {
  const surface = session?.surface?.nodes;
  if (!surface || typeof session.eventAt !== 'function') return [];
  const arr = [...surface];
  // N1：只比「长度 + 首 + 尾」会漏掉中间的单节点替换（长文落盘 startSeq===endSeq 就是这种）。
  // P6：整串 join 每次都要拼一个几万字符的新串；改用数字滚动哈希，仍覆盖中间替换，但不分配大字符串。
  let hash = 0
  for (const seq of arr) hash = (Math.imul(hash, 31) + (Number(seq) | 0)) | 0
  const version = arr.length + ':' + hash;
  const hit = nodesCache.get(session);
  if (hit && hit.version === version) return hit.nodes;
  const nodes = [];
  for (const seq of arr) {
    const ev = session.eventAt(seq);
    if (!ev || typeof ev.time !== 'number') continue;
    nodes.push({ seq, type: ev.type, time: ev.time, event: ev });
  }
  nodes.sort((a, b) => a.seq - b.seq);
  nodesCache.set(session, { version, nodes });
  return nodes;
}
// 外部重写检测用的会话文件指纹（缺陷 1）
const logStamp = new Map();

// O10（2026-11-18）：区间表代理 —— 有 .seqs.json 时只读几 KB 判断覆盖，不解压整包



// O10（2026-11-18）：seqs.json 只有在「覆盖整个归档文件」时才可信。
// 判定：自举写过的 complete:true，或 frames.jsonl 的字节和恰好等于文件大小。
// 否则历史文件只有部分区间，误用会把未覆盖的 seq 判成「未归档」→ 裁切停摆。


// 组合视图：镜像 Map + 归档（Map 或 SeqRanges）+ 会话日志兜底补进来的条目


// O10（2026-11-18）：归档文件日封后不可变，按 mtime+size 签名缓存解压结果；
// 同一文件在进程生命周期内只解压一次（LRU 限制 6 个文件，防内存无上限）。





// 会话日志路径（用于外部改动检测：vacuum 之类会重写同一份文件）
// O20：按 sid 缓存，命中就直接 stat 验证；失效（文件没了/被移走）才重新扫
const logPathCache = new Map();
function sessionLogPath(sid) {
  const hit = logPathCache.get(sid)
  if (hit) {
    try { if (fs.existsSync(hit)) return hit } catch {}
    logPathCache.delete(sid)
  }
  try {
    for (const ws of fs.readdirSync(path.join(HOME, 'sessions'))) {
      const dir = path.join(HOME, 'sessions', ws, sid)
      const p = path.join(dir, sessionFileName(dir))
      if (fs.existsSync(p)) { logPathCache.set(sid, p); return p }
    }
  } catch {}
  return null
}

// 兜底归档：直接读 DSH 自己的会话日志（session.v4.jsonl.zstd / .jsonl）
// 没有镜像/归档插件的机器靠这个确认「原文还在」，才允许裁。


const done = new Set(); // 本进程内已经裁过的区间，防重复追加标记
const DONE_MAX = 200 // 5.3：只增不减会随进程寿命累积，超过上限按插入序淘汰
function markDone(key) {
  done.add(key);
  while (done.size > DONE_MAX) done.delete(done.values().next().value);
}

/** 读镜像区（当天实时镜像 + 已封存的副本），只认逐行解析通过的事件 */
// O10（2026-11-18）：镜像文件同样按 mtime+size 签名缓存（当天文件会增长，签名变了才重读；
// 已封存的文件不可变，长期复用）。


/** 工具配对平衡：数「未闭合的工具调用」，用事件类型数而不是官方 assistant/message 里的 tool-call 块 */



const UPD_FILE = path.join(HOME, 'state/log-prune-update.json');
const UPD_TTL_MS = 6 * 3600e3;

async function checkUpdate(force) {
  const cur = VERSION
  // 关掉自动检查：一个外网请求都不发（面板上的「自动检查更新」开关控制这一项）
  // force=true 是用户手动点「检查更新」：绕过开关和缓存，显式请求一次
  if (!force) {
    try { if (loadConfig().updateCheck === false) return { ok: false, disabled: true, current: cur, latest: '', hasUpdate: false } } catch {}
    try {
      const c = JSON.parse(fs.readFileSync(UPD_FILE, 'utf8'));
      if (Date.now() - (c.at || 0) < UPD_TTL_MS) return c;
    } catch {}
  }
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5000);
    const r = await fetch('https://api.github.com/repos/Rotsins/dsh-log-prune/releases/latest', {
      signal: ac.signal,
      headers: { 'user-agent': 'dsh-log-prune', accept: 'application/vnd.github+json' },
    });
    clearTimeout(t);
    const j = await r.json();
    const latest = String(j.tag_name || '').replace(/^v/, '');
    // 只比「有没有更新的版本」：latest 比当前旧也算已是最新（本地装了未发布版时不提示降级）
    // B13：改用 semver.compareLoose，预发布/四段版本不再被当成「有新版」
    const out = { ok: true, at: Date.now(), current: cur, latest, hasUpdate: !!latest && compareLoose(latest, cur) > 0 };
    try { fs.mkdirSync(path.dirname(UPD_FILE), { recursive: true }); fs.writeFileSync(UPD_FILE, JSON.stringify(out)) } catch {}
    return out;
  } catch (e) {
    // 失败不落缓存，下次展开面板再试；界面上什么都不显示
    return { ok: false, current: cur, latest: '', hasUpdate: false, error: String(e?.message ?? e) };
  }
}

// 从预设文件里找官方的压缩阈值比例（thresholdRatio）
function readRatio(file, presetName) {
  let txt = ''
  try { txt = fs.readFileSync(file, 'utf8') } catch { return null }
  const lines = txt.split('\n')
  if (!presetName) {
    for (const l of lines) { const t = /thresholdRatio:\s*([0-9.]+)/.exec(l); if (t) return Number(t[1]) }
    return null
  }
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)name:\s*["']?([^"']+)["']?\s*$/.exec(lines[i])
    if (!m || m[2].trim() !== presetName) continue
    const base = m[1].length
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]
      if (!l.trim()) continue
      if (l.length - l.trimStart().length <= base) break
      const t = /thresholdRatio:\s*([0-9.]+)/.exec(l)
      if (t) return Number(t[1])
    }
  }
  return null
}

// P18：GET /config 每次都扫盘 + 解析，按 sid + 预设缓存文件的 mtime 缓存一层
const presetCache = new Map()
function readPresetInfoCached(sid) {
  if (!sid) return readPresetInfo(sid)
  const pj = path.join(HOME, 'storages/session_projcache/sessions', sid + '.json')
  let mtime = 0
  try { mtime = fs.statSync(pj).mtimeMs } catch {}
  const hit = presetCache.get(String(sid))
  if (hit && hit.mtime === mtime && mtime > 0) return hit.out
  const out = readPresetInfo(sid)
  if (mtime > 0) presetCache.set(String(sid), { mtime, out })
  return out
}

// 「官方压缩阈值」不给手填：按会话当前预设 + 窗口算出来，连同来源一起给界面
function readPresetInfo(sid) {
  const out = { name: '', ratio: null, point: null, window: 0, source: '' }
  if (!sid) return out
  try {
    const j = JSON.parse(fs.readFileSync(path.join(HOME, 'storages/session_projcache/sessions', sid + '.json'), 'utf8'))
    out.name = String(j?.record?.rows?.agentPreset?.val || '')
    out.window = Number(j?.record?.rows?.contextPressure?.val?.contextWindow || 0)
  } catch {}
  if (!out.name) return out
  const cands = []
  const addProfileCands = (profDir) => {
    cands.push({ file: path.join(profDir, 'node_modules/dsh-flash-presets/presets', out.name + '.patch.yml'), byName: false })
    cands.push({ file: path.join(profDir, 'cordis.patch.yml'), byName: true })
  }
  // 1. profile 目录：web 优先（当前运行 profile），再扫其它（数据目录布局 Linux/Windows 可能不同）
  try {
    let profs = fs.readdirSync(path.join(HOME, 'profiles'))
    profs = ['web', ...profs.filter((p) => p !== 'web')]
    for (const p of profs) addProfileCands(path.join(HOME, 'profiles', p))
  } catch {}
  // 2. 桌面版 exe 旁的资源树（Windows 上 dsh-flash-presets 在 exe 的 node_modules 里）
  try {
    const exeDir = path.dirname(process.execPath)
    for (const base of [path.join(exeDir, 'resources/app.asar/node_modules'), path.join(exeDir, 'node_modules')]) {
      cands.push({ file: path.join(base, 'dsh-flash-presets/presets', out.name + '.patch.yml'), byName: false })
    }
  } catch {}
  // 3. 当前工作目录的 node_modules（开发环境兜底）
  try { cands.push({ file: path.join(process.cwd(), 'node_modules/dsh-flash-presets/presets', out.name + '.patch.yml'), byName: false }) } catch {}
  for (const c of cands) {
    const r = readRatio(c.file, c.byName ? out.name : '')
    if (r != null) {
      out.ratio = r
      out.source = c.file.split(path.sep).slice(-4).join('/')
      break
    }
  }
  if (out.ratio != null && out.window) out.point = Math.round(out.ratio * out.window)
  return out
}

// 进程级单例标志（2026-11-17）：模块可能被加载多份（多个预设各挂一次），
// 模块内变量各算各的，挡不住重复启动 watcher / 重复注册 pre-step → 两个实例同时裁同一会话，
// prune 与替换交错，会话损坏。用 globalThis 上的同一份对象。
const FLAGS = globalThis.__dshLogPruneFlags || (globalThis.__dshLogPruneFlags = {
  updateRoute: false, configRoute: false, watcher: false, statusTool: false,
  repairRoute: false, fuseRoute: false, landing: false, uiRoute: false, preStep: false,
  plainTools: false, panelRoute: false, lockedRoute: false, volumeRoute: false, cleanArchiveRoute: false,
});
export function apply(ctx) {
  // 全局硬门槛：Node <22.15 或没有内置 zstd 时拒绝激活。
  // 低版本即使能在线裁切，后续清理/修复也没有 zstd 兜底，可能损坏会话。
  const nodeProblem = nodeRequirement()
  if (nodeProblem) {
    console.error('[log-prune] ' + nodeProblem + '：本插件要求全局 Node >= 22.15 且内置 zstd，已拒绝激活')
    return
  }
  // B20：至少把最终 HOME 打一行，便于发现「模块加载时与 apply 时 DSH_HOME 不一致」
  try { console.log('[log-prune] HOME=' + resolveHome() + (process.env.DSH_HOME ? '（DSH_HOME=' + process.env.DSH_HOME + '）' : '')) } catch {}
  // 2026-11-19：vendorPath 惰性补齐（N2）——worker 解压用包内自带的 fzstd
  try { if (!fzstdVendorPath) fzstdVendorPath = fileURLToPath(new URL('./vendor/fzstd.mjs', import.meta.url)) } catch {}
  // 2026-11-19：宿主版本软校验（D6）——不在 peer 区间只 warn，不阻止激活
  try {
    const req = createRequire(import.meta.url)
    const dshPkg = JSON.parse(fs.readFileSync(req.resolve('@deepseek-ai/dsh/package.json'), 'utf8'))
    if (!hostCompatible(dshPkg.version)) console.warn('[log-prune] 宿主版本 ' + dshPkg.version + ' 不在 peer 区间（>=0.2.1-rc.2 <0.3.0），可能不兼容')
  } catch {}
  try { TB = ctx.get('toolbox') } catch {}
  // V6：不只检查「有没有 toolbox」，还检查契约版本和必需方法，避免运行到一半 TypeError
  if (TB) {
    const need = ['decompressZstd', 'checkSession', 'repairOrphans', 'repairPruneSpans']
    const missing = need.filter((k) => typeof TB[k] !== 'function')
    if (TB.apiVersion !== 1 || missing.length) {
      console.error('[log-prune] toolbox 契约不匹配（apiVersion=' + TB.apiVersion + '；缺 ' + (missing.join(',') || '无') + '），本插件不激活')
      TB = null
    }
  }
  // C2（2026-11-19）：工具箱是裁切的硬前置。缺失时明确报错并拒绝激活，绝不静默降级到
  // 内置单帧解压（N2/Q1 的根因）。log() 在下方才定义，故这里直接用 console.error。
  if (!TB) {
    console.error('[log-prune] 未检测到 dsh-toolbox（裁切的硬前置，请先安装并启用工具箱），本插件不激活');
    return;
  }
  try {
    if (typeof TB.decompressZstd === 'function') fzstdDecompress = TB.decompressZstd
    if (TB.fzstdVendorPath) fzstdVendorPath = TB.fzstdVendorPath
    // C2：解压能力无条件注入归档模块（worker 路径也由它传）。TB 恒真由 inject + fail-fast 保证；
    // 即便工具箱 decompressZstd 缺失，fzstdDecompress 仍是模块顶部已惰性补齐的自带 vendor，多帧读取不破。
    setZstd({ decompress: fzstdDecompress, vendorPath: fzstdVendorPath })
  } catch (e) {
    console.error('[log-prune] 解压能力注入失败：' + (e?.message ?? e));
  }
  // P1：tmpdir 日志超过 5MB 滚动一份 .1，不再无限增长（Windows 上 rename 前先 unlink）
  let logN = 0
  const log = (m) => {
    try { ctx.logger?.info?.('[log-prune] ' + m); } catch {}
    try {
      const lf = path.join(tmpdir(), 'log-prune.log')
      fs.appendFileSync(lf, tsLocal() + ' ' + m + "\n")
      if (++logN % 200 === 0) {
        if (fs.statSync(lf).size > 5 * 1024 * 1024) {
          try { fs.unlinkSync(lf + '.1') } catch {}
          try { fs.renameSync(lf, lf + '.1') } catch {}
        }
      }
    } catch {}
  };
  // V1：启动一次性能力自检，面板/日志都能看到「缺什么」，不再逐个按钮报不同错误
  const caps = (() => { try { return checkCapabilities() } catch (e) { return { node: process.version, zstdWrite: false, zstdRead: false, zstdCli: false, ok: false, error: String(e?.message ?? e) } } })()
  log('能力：node=' + caps.node + ' zstdWrite=' + caps.zstdWrite + ' zstdRead=' + caps.zstdRead + ' zstdCli=' + caps.zstdCli)
  // 2026-11-19：向工具箱统一反馈注册裁切探针（只上报状态，不做 UI、不联网）
  try {
    if (TB && TB.feedback && typeof TB.feedback.registerProbe === 'function') {
      TB.feedback.registerProbe(() => {
        const st = readStatus()
        const rows = Object.entries(st || {}).filter(([, v]) => v && typeof v === 'object' && v.at)
        rows.sort((a, b) => Number(b[1].at) - Number(a[1].at))
        const recent = rows.slice(0, 2).map(([sid, v]) => ({
          sid: String(sid).slice(0, 16),
          cut: v.cut || '', saved: v.saved || 0, summarySeq: v.summarySeq || 0,
          ok: v.ok, reason: v.reason || '', detail: v.detail || '', verify: v.verify || '',
        }))
        let armed = 0
        try { armed = fs.readdirSync(ARMED_DIR).length } catch {}
        let tokens = null
        try {
          const files = fs.readdirSync(TOK_DIR).filter((f) => f.endsWith('.json'))
            .map((f) => path.join(TOK_DIR, f))
          files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
          if (files[0]) tokens = JSON.parse(fs.readFileSync(files[0], 'utf8'))
        } catch {}
        let logTail = []
        try { logTail = fs.readFileSync(path.join(tmpdir(), 'log-prune.log'), 'utf8').split('\n').filter(Boolean).slice(-20) } catch {}
        const issues = []
        for (const r of recent) {
          if (r.ok === false) {
            issues.push({ severity: 'error', message: '裁切状态异常（' + r.sid + '）：' + (r.reason || r.detail || 'ok=false') })
          }
        }
        if (logTail.some((l) => l.indexOf('归档未就绪') >= 0)) {
          issues.push({ severity: 'warn', message: '最近日志出现「归档未就绪」，裁切被闸门跳过' })
        }
        return {
          kind: 'log-prune', name: '日志裁切', version: VERSION, at: new Date().toISOString(),
          issues,
          snapshot: {
            config: { summaryPoint: _boot.summaryPoint, summaryTrigger: _boot.summaryTrigger, triggerRatio: _boot.triggerRatio, keepTurns: _boot.keepTurns, plainEnabled: _boot.plainEnabled },
            recentPruneStatus: recent,
            armedFiles: armed,
            latestTokens: tokens,
            logTail,
          },
        }
      }, 'log-prune')
    }
  } catch (e) { log('反馈探针注册失败：' + (e?.message ?? e)) }

  const dlog = (m) => { if (DEBUG) log(m); }; // O15：诊断类日志走这里
  let freezeMessage = null;
  let createUserMessage = null;
  let canWrite = false;
  // 缺陷 4：插件重载时复位模块级「只注册一次」标志。
  // 路由和监听都是 ctx.effect 注册的，卸载时会被销毁；标志不复位，新实例就再也不注册，
  // 功能静默消失（pre-step 踩过这个坑，其余八个标志同样会踩）。
  try {
    ctx.effect(() => () => {
      FLAGS.watcher = false; FLAGS.statusTool = false; FLAGS.configRoute = false;
      FLAGS.updateRoute = false; FLAGS.repairRoute = false; FLAGS.fuseRoute = false;
      FLAGS.uiRoute = false; FLAGS.landing = false;
      FLAGS.panelRoute = false; FLAGS.lockedRoute = false;
      FLAGS.plainTools = false; FLAGS.volumeRoute = false; FLAGS.cleanArchiveRoute = false;
    });
  } catch (e) { log('标志复位钩子注册失败：' + (e?.message ?? e)) }
  // 宿主工厂拿不到时，自建消息也必须带 id（核心只校验 id；上次写坏就是少了它）
  const buildUserMessage = (content, source) => {
    if (createUserMessage) return createUserMessage({ content, source })
    if (freezeMessage) return freezeMessage({ role: 'user', content, source })
    return { id: randomUUID(), role: 'user', content, source }
  };


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
    // 扫全部 lib/*.mjs|js 与 bin/*.mjs：原来只比 index/watcher/config 三个文件，
    // 改 zstd-safe 这类模块时提示会失真（进程新、但显示的不是改动文件）。
    const selfDir = path.dirname(fileURLToPath(import.meta.url));
    const dirs = [selfDir, path.join(selfDir, '..', 'bin')];
    let newest = 0, newestFile = '';
    for (const d of dirs) {
      let names = [];
      try { names = fs.readdirSync(d) } catch { continue }
      for (const f of names) {
        if (!/\.(mjs|js)$/.test(f) || f.startsWith('.') || f.includes('.bak-')) continue;
        try {
          const t = fs.statSync(path.join(d, f)).mtimeMs;
          if (t > newest) { newest = t; newestFile = path.basename(d) + '/' + f }
        } catch {}
      }
    }
    const startedAt = Date.now() - process.uptime() * 1000;
    const stale = newest > startedAt + 1000;
    log('插件代码：最新改动 ' + newestFile + ' ' + tsLocal(new Date(newest)) +
      '，进程启动 ' + tsLocal(new Date(startedAt)) +
      (stale ? ' → 有更新未加载，需重启' : ' → 已是最新'));
  } catch {}
  const agentsSvc = ctx.get('agents');
  log('agents 服务：' + (agentsSvc?.get ? '可用（进程内派发）' : '不可用（需要 summaryClientPath）'));
  // P11：IS_DESKTOP 之前定义了没人用，这里补日志，排查桌面端/服务端差异时有用
  log('运行环境：' + (IS_DESKTOP ? '桌面端' : 'Node/web') + ' · 访问守卫：回环放行' +
    (loadConfig().allowRemote ? '，非回环需 x-lp-token' : '，非回环默认拒绝（allowRemote=false）'));
  // —— 不依赖 agent/pre-step 的自我探测（缺陷 2/3 修复，2026-11-16）——
  // 预设作用域里的插件收不到 agent 事件（见 state/log-prune-audit-20261116.md），
  // 所以 watcher 每次 tick 自己去 agents 服务里找活的 agent、量 token、写状态文件，
  // 到线时直接触发裁切。事件通不通都不再影响主功能。
  // 裁切触发冷却：watcher 每 20 秒一轮，别让它同一会话反复触发重活
  const pruneCooldown = new Map();
  const liveAgent = (sid) => { try { const svc = ctx.get('agents'); return svc?.get?.(sid) ?? null } catch { return null } };
  const liveAgents = () => { try { const svc = ctx.get('agents'); return svc?.list?.() ?? [] } catch { return [] } };
  // 2026-11-17：空闲会话没有活 agent，watcher 以前直接 return false，永远裁不了。
  // 这里给一个「离线会话」：自己把日志读进内存、按表面规则重放，append 时按「一条一帧」追加回文件。
  // 安全闸：文件 120 秒内有写入、或 session.lock 存在且新鲜，就不碰（可能正被进程写）。
  const offlineAgent = (sid) => {
    try {
      // O13（2026-11-18）：Node <22.15 没有 zstdCompressSync，写侧会 TypeError → 被 per-span catch 吃掉
      // → failCount++ → 连拒 3 次熔断。这里先做能力闸，失败不累计。
      const zc = zlib.zstdCompressSync || zlib.default?.zstdCompressSync
      if (typeof zc !== 'function') { log('离线裁切跳过 ' + String(sid).slice(0, 20) + '：Node 缺少 zstd 压缩（需 22.15+）'); return null }
      const roots = []
      try { for (const ws of fs.readdirSync(path.join(HOME, 'sessions'))) roots.push(path.join(HOME, 'sessions', ws, sid)) } catch {}
      const dir = roots.find((p) => { try { return fs.statSync(path.join(p, sessionFileName(p))).isFile() } catch { return false } })
      if (!dir) { log('离线跳过 ' + String(sid).slice(0, 20) + '：找不到会话目录'); return null }
      const file = path.join(dir, sessionFileName(dir))
      const stFile = fs.statSync(file)
      // 闸门原来写 120 秒，等于要求会话「静两分钟」——真实环境里几乎不可能满足（文件/锁会被心跳刷新）。
      // 2026-11-17 改成 10 秒：只在刚写完的瞬间避开，其余时间都允许离线裁。
      if (Date.now() - stFile.mtimeMs < 10e3) { log('离线跳过 ' + String(sid).slice(0, 20) + '：文件 10 秒内刚写过'); return null }
      const raw = readZstd(file)
      if (!raw) return null
      const TYPES = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result'])
      const events = new Map(); let max = 0
      for (const line of String(raw).split('\n')) {
        if (!line) continue
        let e; try { e = JSON.parse(line) } catch { continue }
        if (typeof e.seq === 'number') { events.set(e.seq, e); if (e.seq > max) max = e.seq }
      }
      if (!events.size) return null
      const surface = []
      for (let s = 0; s <= max; s++) {
        const e = events.get(s); if (!e || !TYPES.has(e.type)) continue
        const op = e.surfaceOp
        if (op === 'append') { surface.push(s); continue }
        if (!op || typeof op !== 'object') continue
        const a = surface.indexOf(op.startSeq), b = surface.indexOf(op.endSeq)
        if (a < 0 || b < a) continue
        surface.splice(a, b - a + 1, s)
      }
      let nextSeq = max + 1
      const session = {
        id: sid,
        surface: { nodes: surface },
        events,
        maxSeq: max,
        eventAt: (s) => events.get(s),
        deriveEventMessage: (ev) => {
          const d = ev && ev.data
          if (!d) return { content: [] }
          if (Array.isArray(d.content)) return { content: d.content }
          if (d.message) return { content: d.message.content || [] }
          return { content: [] }
        },
        append: (type, data, opts) => {
          const ev = { type, seq: nextSeq++, time: Date.now(), data: data || {} }
          if (opts && opts.surfaceOp) ev.surfaceOp = opts.surfaceOp
          // 2026-11-19：替换节点必须带上被遮蔽的 seq 列表，DSH 投影会话时要读它；
          // 离线裁切这条写入路径以前只抄 surfaceOp，结果写完会话直接打不开。
          if (opts && Array.isArray(opts.sourceEventSeqs)) ev.sourceEventSeqs = opts.sourceEventSeqs
          fs.appendFileSync(file, zc(Buffer.from(JSON.stringify(ev) + '\n')))
          events.set(ev.seq, ev)
          const op = ev.surfaceOp
          if (op === 'append') surface.push(ev.seq)
          else if (op && typeof op === 'object') {
            const a = surface.indexOf(op.startSeq), b = surface.indexOf(op.endSeq)
            if (a >= 0 && b >= a) surface.splice(a, b - a + 1, ev.seq)
          }
          return ev
        },
      }
      log('离线会话：' + String(sid).slice(0, 20) + '（无活 agent，直接读日志裁）')
      return { session }
    } catch (e) { log('离线读取失败 ' + String(sid).slice(0, 20) + '：' + (e?.message ?? e)); return null }
  };
  const probeSession = (sid) => {
    try {
      const session = liveAgent(sid)?.session;
      if (!session) return null;
      const nodes = collectNodes(session);
      const measured = measureTokens(session, nodes);
      if (!measured.tokens) return null;
      const tokens = measured.tokens;
      const lastSeq = nodes.length ? nodes[nodes.length - 1].seq : 0;
      const summarySeq = scanSummarySeq(session);
      const out = { tokens, lastSeq, firstSeq: nodes[0]?.seq ?? 0, summarySeq, src: measured.src, at: Date.now() };
      fs.mkdirSync(TOK_DIR, { recursive: true });
      fs.writeFileSync(path.join(TOK_DIR, sid + '.json'), JSON.stringify(out));
      return out;
    } catch (e) { log('探测失败 ' + String(sid).slice(0, 20) + '：' + (e?.message ?? e)); return null }
  };
  const pruneNow = (sid, opts = {}) => {
    try {
      // 有活 agent 用它；空闲会话走离线读取（见 offlineAgent）
      const agent = liveAgent(sid) || offlineAgent(sid);
      if (!agent) return false;
      const cfg = effectiveConfig(sid);
      const st = (() => { try { return JSON.parse(fs.readFileSync(path.join(TOK_DIR, sid + '.json'), 'utf8')) } catch { return null } })();
      const hardLine = Math.round(Number(cfg.compactPoint || 0) * Number(cfg.triggerRatio || 0));
      const line = hardLine; // 强制裁切恒用硬线，summaryTrigger 不再参与（2026-11-17 管理员纠正）
      if (!st || typeof st.tokens !== 'number') return false;
      // 2026-11-17 管理员定：上弦期间，摘要一落地（且是本次派发之后写的）就裁，不看到线、不等下一条消息。
      // 没上弦的老逻辑：到线才裁。
      // 2026-11-17 管理员定：表层（上弦）与中层（55 万兜底）互不阻挡。
      // 触发条件 = 到线（中层）或 上弦且摘要已落地（表层），两者任一成立就进 pruneStep。
      const armed = (() => { try { return JSON.parse(fs.readFileSync(path.join(ARMED_DIR, sid + '.json'), 'utf8')) } catch { return null } })();
      // force：由「会话文件变了」触发的检查（2026-11-17 管理员定）。
      // 不再依赖 token 状态文件里的 summarySeq——那个文件是 pre-step/探测时才刷新的，
      // 实测摘要落地后快通道要等 95 秒才看见（11:25:35 落地，11:27:10 才裁）。
      // 现在直接进 pruneStep，由它扫真实表面判断摘要是否落地。
      const armedReady = !!armed && (opts.force === true || (typeof st.summarySeq === 'number' && st.summarySeq > Number(armed.to || 0)));
      const overLine = !!line && typeof st.tokens === 'number' && st.tokens >= line;
      if (!overLine && !armedReady) return false;
      if (armedReady && !opts.force && Date.now() - (st.at || 0) < 5000) return false; // 刚写过状态，可能还在收尾
      // 别把剩下的也裁了：已经低于保留线就没必要动
      const keepNow = Number(cfg.keepTokens || 0);
      if (keepNow && typeof st.tokens === 'number' && st.tokens <= keepNow) return false;
      const coolMs = overLine ? 120e3 : (opts.force ? 5e3 : 15e3);
      if (Date.now() - (pruneCooldown.get(sid) || 0) < coolMs) return false;
      pruneCooldown.set(sid, Date.now());
      log('watcher 触发裁切 ' + String(sid).slice(0, 20) + ' tokens=' + st.tokens + '/' + line);
      void pruneStep({ agent }, async () => {});
      return true;
    } catch (e) { log('触发裁切失败：' + (e?.message ?? e)); return false }
  };
  if (!FLAGS.watcher) {
    FLAGS.watcher = true;
    startWatcher(ctx, {
      getConfig: loadConfig,
      getConfigFor: (sid) => effectiveConfig(sid),
      deliverPrompt,
      probe: probeSession,
      pruneNow,
      listSessions: () => liveAgents().map((a) => String(a?.session?.id || a?.id || '')).filter(Boolean),
      // O2：时代合并需要 session 句柄扫残留（只有活 agent 能派任务，离线会话自动跳过）
      getSession: (sid) => { try { return liveAgent(sid)?.session ?? null } catch { return null } },
      log,
    });
  }
  // 巡检（2026-11-17 曾每 5 分钟自动查+自动修，已停用）：
  // 事故：checkSession(force) 用「整份日志的最终表面」校验历史 prune，被替换过的历史段
  // 早已不在最终表面里，于是永远判 span 坏；repairOrphans 再按「抄上一条有效 prune 的范围」
  // 去改，把本来正确的数据改坏（10:59 一次，把我 10:53 修好的 6 条又改回错的）。
  // 现在这里什么都不做：巡检插件已停用，修复由面板手动触发（工具箱实现），不再常驻自动检测。

  // —— 给会话一个查 token 的工具（2026-11-15 管理员定）——
  // 模型自己看不到上下文 token 数，只能由插件把实测值递过去。
  const sidFromExec = (exec) => {
    try {
      const a = exec && (exec.agent || exec.caller || exec.agentRef);
      if (a && a.session) return String(a.session.id || '');
      if (a && typeof a === 'object') {
        for (const k of ['sessionId', 'id']) if (typeof a[k] === 'string' && a[k]) return a[k];
      }
    } catch {}
    return '';
  };
  (async () => {
    try {
      if (FLAGS.statusTool || !ctx.tools || typeof ctx.tools.register !== 'function') return;
      FLAGS.statusTool = true;
      const toolsMod = await fromHostTree('dsh-tools');
      const defineTool = toolsMod?.defineTool;
      if (typeof defineTool !== 'function') { log('状态工具：宿主没有 defineTool，跳过'); return }
      const tool = defineTool({
        name: 'log_prune_status',
        description: '查当前会话的上下文 token 占用和裁切阈值（摘要线 / 强制裁切线 / 保留线）。' +
          '想判断「现在该不该裁、该不该写摘要」时用它，返回的是上一轮实测值，别自己数。',
        parameters: {},
        output: {
          schema: {
            type: 'object', additionalProperties: false,
            properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
          },
          render(_args, value) { return [{ type: 'text', text: value && value.text ? value.text : '（没读到当前会话的 token）' }] },
        },
        async execute(_args, exec) {
          const sid = sidFromExec(exec);
          if (!sid) return { ok: false, text: '没识别到当前会话' };
          let st = null;
          try { st = JSON.parse(fs.readFileSync(path.join(TOK_DIR, sid + '.json'), 'utf8')) } catch {}
          const cfg = effectiveConfig(sid);
          const summaryLine = Number(cfg.summaryPoint || 0);
          const hardLine = Math.round(Number(cfg.compactPoint || 0) * Number(cfg.triggerRatio || 0));
          const keepLine = Number(cfg.keepTokens || 0);
          const tokens = st && typeof st.tokens === 'number' ? st.tokens : null;
          const parts = [];
          parts.push(tokens == null ? '上下文 token：还没测到（这一轮还没跑过）' : '上下文 ' + tokens + ' token（上一轮实测）');
          parts.push('摘要线 ' + summaryLine + ' · 强制裁切线 ' + hardLine + ' · 保留线 ' + keepLine);
          if (tokens != null && summaryLine && tokens >= summaryLine) parts.push('已过摘要线，该写摘要了');
          if (tokens != null && hardLine && tokens >= hardLine) parts.push('已过强制裁切线');
          if (st && st.summarySeq) parts.push('已有摘要 seq=' + st.summarySeq);
          // D2：上次裁切留了孤儿 prune 时主动提示（面板与模型都能看到）
          try {
            const orph = orphanOf(readStatus()[sid]);
            if (orph) parts.push('⚠ 上次裁切留下孤儿 prune seq=' + (orph.seq || '?') + '（替换范围 ' + (orph.range || '?') + '），建议修复会话');
          } catch {}
          return { ok: true, text: parts.join('；') };
        },
      });
      ctx.tools.register(tool);
      log('状态工具已注册：log_prune_status');
    } catch (e) {
      FLAGS.statusTool = false;
      log('状态工具注册失败：' + (e?.message ?? e));
    }
  })();


  // —— 检索被裁内容：轻索引（首句+显著词）→ 命中后按需解压归档读原文（2026-11-17）——
  (async () => {
    try {
      if (FLAGS.plainTools || !ctx.tools || typeof ctx.tools.register !== 'function') return;
      FLAGS.plainTools = true;
      const toolsMod = await fromHostTree('dsh-tools');
      const defineTool = toolsMod?.defineTool;
      if (typeof defineTool !== 'function') { log('检索工具：宿主没有 defineTool，跳过'); return }
      const outSpec = {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, text: { type: 'string' } } },
        render(_a, v) { return [{ type: 'text', text: v && v.text ? v.text : '（没读到）' }] },
      };
      ctx.tools.register(defineTool({
        name: 'log_prune_read',
        description: '读取本会话被裁掉的原文：参数是门牌上的 seq 区间（例如 83079,83190）。只解压命中的那一个归档文件，别一次拉几百条；按关键词找请先用 log_prune_search。',
        parameters: { seqFrom: { type: 'number', description: '起始 seq（门牌 seq=a-b 的 a）' }, seqTo: { type: 'number', description: '结束 seq（门牌的 b）' } },
        output: outSpec,
        async execute(args, exec) {
          const sid = sidFromExec(exec);
          if (!sid) return { ok: false, text: '没识别到当前会话' };
          try { return await readText(PLAIN_INDEX_DIR, sid, args.seqFrom, args.seqTo, readArchiveTexts, {
            plainFileFor: (r) => plainFileForDay(sid, r.time),
            readPlainTexts,
            archiveFileFor: (r) => archiveFileForDay(sid, r.time),
            loadArchiveMap: (r) => dayOf(r.time) < dayOf(Date.now())
              ? loadArchive(sid, effectiveConfig(sid).archiveDir || ARCHIVE_DIR)
              : new Map(),
            // O1.2：索引无条目时的归档直读兜底——loadArchive 已按帧缓存，按 seq 命中文件后整段读出
            readArchiveRange: async (from, to) => {
              try {
                const arch = loadArchive(sid, effectiveConfig(sid).archiveDir || ARCHIVE_DIR)
                if (!arch || !arch.size) return { empty: true }
                if (to - from > 200000) return { empty: true }   // 区间异常大：多半是门牌写错，不硬翻
                const byFile = new Map()
                for (let s = from; s <= to; s++) {
                  if (!arch.has(s)) continue
                  const hit = arch.get(s)
                  if (!hit || !hit.file) continue
                  if (!byFile.has(hit.file)) byFile.set(hit.file, new Set())
                  byFile.get(hit.file).add(s)
                }
                if (!byFile.size) return { empty: true }
                const out = []
                let total = 0
                for (const [file, want] of byFile) {
                  const texts = await readArchiveTexts(file, want)
                  for (const s of [...want].sort((a, b) => a - b)) {
                    const t = texts.get(s)
                    if (t === undefined) continue
                    if (total >= 60000) { out.push('…（已达返回上限，缩小 seq 区间再读）'); break }
                    out.push('--- seq=' + s + ' ---\n' + t)
                    total += t.length + 16
                  }
                  if (total >= 60000) break
                }
                if (!out.length) return { empty: true }
                return { ok: true, text: out.join('\n\n') }
              } catch { return { empty: true } }
            },
          }) } catch (e) { return { ok: false, text: '读取失败：' + (e?.message ?? e) } }
        },
      }));
      ctx.tools.register(defineTool({
        name: 'log_prune_search',
        description: '在「本会话被裁掉的原文」里按关键词找内容，返回 seq / 时间 / 角色和一句摘录。找之前的结论、文件名、报错时用它；命中后用 log_prune_read 取全文。',
        parameters: { keyword: { type: 'string', description: '关键词（中英文都行）' }, maxHits: { type: 'number', description: '最多返回几条，默认 12' } },
        output: outSpec,
        async execute(args, exec) {
          const sid = sidFromExec(exec);
          if (!sid) return { ok: false, text: '没识别到当前会话' };
          try {
            const r = grepIndex(PLAIN_INDEX_DIR, sid, args.keyword, { maxHits: args.maxHits });
            if (!r.ok) return { ok: false, text: r.text };
            const note = r.count > r.hits.length
              ? '\n共 ' + r.count + ' 条命中，显示最近 ' + r.hits.length + ' 条；可用更具体的关键词缩小范围'
              : '';
            return { ok: true, text: r.hits.join('\n') + note };
          } catch (e) { return { ok: false, text: '检索失败：' + (e?.message ?? e) } }
        },
      }));
      log('检索工具已注册：log_prune_read / log_prune_search');
    } catch (e) {
      FLAGS.plainTools = false;
      log('检索工具注册失败：' + (e?.message ?? e));
    }
  })();


  // —— 设置卡片用的配置读写接口 ——
  // 会话状态缓存：影子对不上表面的会话标红点（坏）
  const badCache = new Map()
  const badOf = async (id, at, force) => {
    if (!force) {
      const c = badCache.get(id)
      if (c && c.at === at) return { bad: c.bad, checked: c.checked }
    }
    // X3：未知（fold 失败/运行中/读不动）不再当成「正常」，单独带 checked:false 给面板显示灰点
    let bad = false, checked = false
    try {
      const r = await checkSession(id, undefined, { force })
      bad = !!r.bad
      checked = r.checked !== false && r.computed !== false
    } catch {}
    if (!force) badCache.set(id, { at, bad, checked })
    return { bad, checked }
  }
  const 发 = (res, code, obj) => {
    try { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) } catch {}
  };
  // 同一进程里可能被多个预设各挂一次，路由只注册一次
  if (!FLAGS.configRoute) try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-log-prune/config',
      handler: async (req, res) => {
        if (!guard(req, res, loadConfig())) return;
        try {
          const u = new URL(req.url, 'http://localhost');
          const sid = u.searchParams.get('sid') || '';
          const forceBad = u.searchParams.get('refresh') === '1';
          // 面板打开时不再自动扫会话列表（列表由「刷新列表」按钮手动取）：
          // nolist=1 只返回配置/状态，跳过 list 扫描
          const nolist = u.searchParams.get('nolist') === '1';
          if (req.method === 'GET') {
            // 会话列表跟 GUI 对齐：只列 workspace 索引里的，已归档的一律不列
            const sessions = nolist ? [] : (() => {
              const list = []
              const cacheDir = path.join(HOME, 'storages/session_projcache/sessions')
              let idx = null
              try { idx = JSON.parse(fs.readFileSync(path.join(HOME, 'storages/workspace.json'), 'utf8')) } catch {}
              const archived = new Set(idx?.global?.archivedSessionIds || [])
              const seen = new Set()
              for (const w of Object.values(idx?.tables?.workspaces || {})) {
                // 「会话存档」这类收容区不进列表，它们只是留着不碍事
                if (/存档|归档/.test(String(w?.title || ''))) continue
                for (const sid of (w.sessionIds || [])) {
                  if (!sid || archived.has(sid) || seen.has(sid)) continue
                  seen.add(sid)
                  let at = 0, cwd = w.path || '', title = ''
                  try { at = fs.statSync(path.join(cacheDir, sid + '.json')).mtimeMs } catch {}
                  try {
                    const jd = JSON.parse(fs.readFileSync(path.join(cacheDir, sid + '.json'), 'utf8'))
                    cwd = jd?.record?.identity?.cwd || cwd
                    title = String(jd?.record?.rows?.title?.val || '')
                  } catch {}
                  list.push({ id: sid, at, cwd, title, ws: String(w.title || '') })
                }
              }
              // 扫描 sessions 目录：加载失败/没进工作区的会话也列出来，用户才能查到 id 去修
              try {
                const root = path.join(HOME, 'sessions')
                for (const wsName of fs.readdirSync(root)) {
                  if (!wsName.startsWith('--')) continue
                  const wsPath = path.join(root, wsName)
                  let st
                  try { st = fs.statSync(wsPath) } catch { continue }
                  if (!st.isDirectory()) continue
                  let sids = []
                  try { sids = fs.readdirSync(wsPath) } catch { continue }
                  for (const sid of sids) {
                    if (!sid.startsWith('session-') || seen.has(sid) || archived.has(sid)) continue
                    let at = 0
                    try { at = fs.statSync(path.join(wsPath, sid, sessionFileName(path.join(wsPath, sid)))).mtimeMs } catch { continue }
                    seen.add(sid)
                    list.push({ id: sid, at, cwd: '', title: '', ws: '（扫描）' })
                  }
                }
              } catch {}
              return list.sort((a, b) => b.at - a.at)
            })()
            // P6：时间统一用会话日志文件的 mtime，但只扫一遍目录建映射（原来每个会话都 readdirSync）
            // O12（2026-11-18）：nolist 轻量加载时整段跳过——打开面板不该扫 sessions 树
            const sidPath = new Map()
            if (!nolist) {
              try {
                const root = path.join(HOME, 'sessions')
                for (const ws of fs.readdirSync(root)) {
                  const wsPath = path.join(root, ws)
                  let names = []
                  try { names = fs.readdirSync(wsPath) } catch { continue }
                  for (const id of names) {
                    const dir = path.join(wsPath, id)
                    const p = path.join(dir, sessionFileName(dir))
                    if (fs.existsSync(p)) sidPath.set(id, p)
                  }
                }
              } catch {}
            }
            for (const item of sessions) {
              try {
                const p = sidPath.get(item.id)
                if (p) item.at = fs.statSync(p).mtimeMs
              } catch {}
            }
            // P6：结构检查（解压 + fold，每个会话约 10ms）只在用户主动刷新时做，否则 100 个会话拖一秒
            if (forceBad) {
              for (const item of sessions) {
                try { const r = item.id === sid ? { bad: false, checked: true } : await badOf(item.id, item.at, true); item.bad = r.bad; item.unknown = !r.checked && !r.bad } catch {}
              }
            } else {
              for (const item of sessions) { item.bad = false; item.unknown = false }
            }
            return 发(res, 200, {
              ok: true, file: CONFIG_PATH,
              config: effectiveConfig(sid),
              global: loadConfig(),
              session: sid ? (loadSessions()[sid] ?? null) : null,
              sessions,
              listSkipped: nolist,
              version: VERSION,
              capabilities: caps,
              preset: readPresetInfoCached(sid),
              recentSessionId: sessions.length ? sessions[0].id : '',
              // P4/H5：把裁切状态一并返回，面板据此显示孤儿提示（/config 本来就是每次必调）
              status: sid ? (readStatus()[sid] || null) : null,
            });
          }
          let body = '';
          for await (const c of req) { body += c; if (body.length > 262144) break };
          const j = body ? JSON.parse(body) : {};
          const cfgIn = j.config ?? j;
          if ('timezone' in cfgIn && !isValidTimeZone(cfgIn.timezone)) return 发(res, 400, { ok: false, error: '时区无效：' + cfgIn.timezone + '（示例 Asia/Shanghai、UTC、America/New_York）' });
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
          // C1：updateCheck 是全局开关（checkUpdate 只读 loadConfig()，没有 sid 上下文），
          // 让它进「会话覆盖」会静默失效——面板显示已保存、外网请求照发。这里把它抬到全局。
          // 每天自动清理（开关/时间）同理：调度只读 loadConfig()，会话覆盖不参与。
          // 面板「其他设置」整组都是全局项（含自动清理开关/时间），会话覆盖不参与
          const 抬 = {}
          for (const k of GLOBAL_KEYS) if (k in cfgIn) { 抬[k] = cfgIn[k]; delete cfgIn[k] }
          if (Object.keys(抬).length) { try { saveConfig(抬) } catch {} }
          setSessionOverride(s, cfgIn);
          发(res, 200, { ok: true, scope: 'session', config: effectiveConfig(s) });
        } catch (e) { 发(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    }));
    FLAGS.configRoute = true;
  } catch (e) { log('配置接口注册失败：' + (e?.message ?? e)) }
  if (!FLAGS.updateRoute) try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-log-prune/update-check',
      handler: async (req, res) => {
        if (!guard(req, res, loadConfig())) return;
        try {
          const u = new URL(req.url, 'http://localhost');
          const out = await checkUpdate(u.searchParams.get('force') === '1');
          return 发(res, 200, out);
        } catch (e) { return 发(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      },
    }));
    FLAGS.updateRoute = true;
  } catch (e) { log('更新检查接口注册失败：' + (e?.message ?? e)) }
  // 面板「尝试修复会话」：检索孤立事件并修复（2026-11-15）
  if (!FLAGS.repairRoute) try {
    FLAGS.repairRoute = true
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-log-prune/repair',
      handler: async (req, res) => {
        if (!guard(req, res, loadConfig())) return;
        try {
          if (req.method !== 'POST') return 发(res, 405, { ok: false, error: 'POST only' })
          let body = ''
          for await (const c of req) { body += c; if (body.length > 262144) break }
          const j = body ? JSON.parse(body) : {}
          const sid = String(j.sid || '')
          if (!sid) return 发(res, 400, { ok: false, error: '缺 sid' })
          // 2026-11-20：面板修复会在主进程解压整份会话，大会话会 OOM（13:41 实测 100MB 会话把 1.9GB 堆打爆）。
          // 超过 40MB 的会话拒绝在面板修，改用独立进程 CLI，避免再次拖垮整个 DSH。
          try {
            const sf = sessionLogPath(sid)
            if (sf && fs.existsSync(sf)) {
              const sz = fs.statSync(sf).size
              if (sz > 40 * 1024 * 1024) {
                return 发(res, 200, { ok: false, error: '会话文件 ' + (sz / 1048576).toFixed(1) + 'MB，面板修复会在主进程解压并耗尽内存；请用独立进程：node bin/repair-session.mjs ' + sid + ' --dry（先看）再不带 --dry 修' })
              }
            }
          } catch {}
          const r = await repairOrphans(sid)
          // P4/H6：修复成功即清提示（found=0 也清——说明之前那个孤儿已经不在）
          if (r && r.ok) {
            clearOrphanRisk(sid);
            // L3：追加而非替换，保留原始 message 里的备份名与复验结果
            // N-b：found=0 时 repairOrphans 已写「没有找到孤立事件」，不再追加重复的「0 条」
            if (r.found > 0 && r.message) r.message = r.message + '（孤立事件 ' + r.found + ' 条）';
          }
          return 发(res, 200, r)
        } catch (e) { return 发(res, 500, { ok: false, error: String(e?.message ?? e) }) }
      },
    }))
  } catch (e) { log('修复接口注册失败：' + (e?.message ?? e)) }
  // 面板「清理归档 stream」：剥掉旧归档里 assistant/message 的 data.stream（2026-11-19）
  if (!FLAGS.cleanArchiveRoute) try {
    FLAGS.cleanArchiveRoute = true
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-log-prune/clean-archive',
      handler: async (req, res) => {
        if (!guard(req, res, loadConfig())) return
        try {
          if (req.method !== 'POST') return 发(res, 405, { ok: false, error: 'POST only' })
          let body = ''
          for await (const c of req) { body += c; if (body.length > 262144) break }
          const j = body ? JSON.parse(body) : {}
          const isDry = j.dry !== false
          const r = await cleanArchiveStreams({ dry: isDry, log })
          // 会话 stream 清理已迁到离线清理（offline-clean）：这里只处理归档，不再碰会话文件。
          if (!isDry && j.restart && (r.cleaned || 0) > 0) r.restart = requestRestart('archive-stream-clean')
          return 发(res, 200, r)
        } catch (e) { return 发(res, 500, { ok: false, error: String(e?.message ?? e) }) }
      },
    }))
  } catch (e) { log('清理归档接口注册失败：' + (e?.message ?? e)) }
  // 离线清理公共派发：面板按钮和每日 04:30 共用（Linux 独立 unit / Windows detached）
  const OFFCLEAN_DIR = path.join(HOME, 'state', 'offclean-runs')
  const OFFCLEAN_LOCK = path.join(HOME, 'state', 'offclean-lock.json')
  const OFFCLEAN_SCRIPT = (() => {
    const cands = [
      process.env.DSH_OFFCLEAN_SCRIPT,
      path.join(HOME, 'bin', 'offline-clean.mjs'),
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'offline-clean.mjs'),
    ].filter(Boolean)
    return cands.find((p) => fs.existsSync(p)) || cands[1]
  })()
  const offCleanLaunch = (runId, opts = {}) => {
    if (!fs.existsSync(OFFCLEAN_SCRIPT)) throw new Error('找不到 offline-clean.mjs（应放 <DSH_HOME>/bin/ 或插件 bin/）')
    if (fs.statSync(OFFCLEAN_SCRIPT).size <= 0) throw new Error('offline-clean.mjs 是空文件，拒绝派发')
    const dry = !!opts.dry
    // 先建运行目录和初始 status：脚本启动前 UI 轮询 /offclean/run 时不至于 404（P5）
    try {
      const rd = path.join(OFFCLEAN_DIR, runId)
      fs.mkdirSync(rd, { recursive: true })
      const sf = path.join(rd, 'status.json')
      if (!fs.existsSync(sf)) fs.writeFileSync(sf, JSON.stringify({ runId, dry, phase: 'P0', label: '已派发', ok: null, counts: null, updatedAt: Date.now() }))
    } catch {}
    const exe = process.env.DSH_EXE || String(process.execPath || '')
    const grace = process.platform === 'win32' ? '15000' : '8000'
    const args = ['--run-id', runId, '--home', HOME, '--pid', String(process.pid), '--exe', exe, '--grace-ms', grace]
    if (process.versions.electron) args.push('--electron')
    if (dry) args.push('--dry-run')
    if (opts.skipArchiveClean) args.push('--skip-archive-clean')
    if (String(opts.restartMode || 'auto') === 'none') args.push('--restart-mode', 'none')
    const nodeExe = process.env.DSH_NODE || process.execPath
    // B1：派发前真校验 node，避免 spawn 的 ENOENT 走异步 error 被吞（DSH 已关、清理却没跑）
    // 桌面端 process.execPath 是 DSH NEXT.exe，必须带 ELECTRON_RUN_AS_NODE 才按 node 跑
    const probe = spawnSync(nodeExe, ['--version'], { stdio: 'ignore', timeout: 5000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    if (probe.error || probe.status !== 0) throw new Error('清理进程的 node 不可用（' + nodeExe + '）：' + String((probe.error && probe.error.message) || ('exit ' + probe.status)))
    let mode = 'detached'
    if (process.platform === 'linux') {
      let ok = false
      try {
        const st = spawnSync('systemd-run', systemdRunArgs({ unit: 'dsh-offclean-' + runId, exe: nodeExe, script: OFFCLEAN_SCRIPT, args, killMode: 'control-group', collect: true, setenv: { DSH_TZ: getTimeZone() } }), { stdio: 'ignore', timeout: 15000 })
        ok = !st.error && st.status === 0
      } catch {}
      if (!ok) throw new Error('systemd-run 不可用：拒绝用 detached 派发（DSH 被 stop 时会连带杀掉清理进程）。请手工运行 offline-clean.mjs，或修复 systemd-run 后重试')
      mode = 'systemd-run'
    }
    if (process.platform === 'win32' && mode !== 'systemd-run') mode = 'windows-detached'
    if (mode === 'detached' || mode === 'windows-detached') {
      const child = spawn(nodeExe, [OFFCLEAN_SCRIPT, ...args], { detached: true, stdio: 'ignore', windowsHide: true, cwd: HOME, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_TZ: getTimeZone() } })
      // B1：spawn 的 ENOENT 是异步 error，外层 try/catch 捕不到；回写 status 让面板看到「派发失败」
      child.on('error', (e) => {
        try {
          const rd = path.join(OFFCLEAN_DIR, runId)
          fs.mkdirSync(rd, { recursive: true })
          fs.writeFileSync(path.join(rd, 'status.json'), JSON.stringify({ runId, dry, phase: 'P0', label: '派发失败', lastMsg: String(e?.message ?? e), ok: false, counts: null, updatedAt: Date.now() }))
        } catch {}
      })
      child.unref()
    }
    return mode
  }
  // 2026-11-20：离线深度清理（关 DSH → 侧车+清理 → 校验 → 拉起）。
  // 脚本必须由 systemd-run 起独立 unit：dsh.service 是 KillMode=mixed，detached 子进程会和 DSH 一起被 stop 杀掉。
  if (!FLAGS.offCleanRoute) try {
    FLAGS.offCleanRoute = true
    const ocReadJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
    const ocRunning = () => { const lk = ocReadJson(OFFCLEAN_LOCK); return !!(lk && lk.runId && Date.now() - (lk.updatedAt || 0) < 5 * 60000) }
    const ocListRuns = () => {
      let names = []
      // .prev-* 是脚本重跑时留下的旧目录备份，不是一次运行；没有 status.json 的目录同理。
      try { names = fs.readdirSync(OFFCLEAN_DIR).filter((d) => /^[\w.\-]+$/.test(d) && !d.includes('.prev-')) } catch {}
      const runs = []
      for (const id of names) {
        const st = ocReadJson(path.join(OFFCLEAN_DIR, id, 'status.json'))
        if (!st) continue
        const rp = ocReadJson(path.join(OFFCLEAN_DIR, id, 'report.json'))
        const plan = (rp && Array.isArray(rp.plan)) ? rp.plan : []
        const planSummary = st.dry ? {
          sessions: (rp && rp.counts && rp.counts.sessionsScanned) || plan.length,
          streams: plan.reduce((a, p) => a + (p.streamEvents || 0), 0),
          toArchive: plan.reduce((a, p) => a + (p.toArchive || 0), 0),
          holes: plan.reduce((a, p) => a + (p.holes || 0), 0),
        } : null
        runs.push({ id, status: st, counts: (rp && rp.counts) || st.counts || null, planSummary, updatedAt: Number(st.updatedAt) || 0 })
      }
      // 按 status.updatedAt 倒序（目录名排序会把 .prev 备份/旧跑顶到前面）
      runs.sort((a, b) => b.updatedAt - a.updatedAt)
      return runs.slice(0, 20)
    }
    const ocBody = async (req) => { let body = ''; for await (const c of req) { body += c; if (body.length > 262144) break }; try { return body ? JSON.parse(body) : {} } catch { return {} } }
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-log-prune/offclean/dispatch',
      handler: async (req, res) => {
        if (!guard(req, res, loadConfig())) return
        // R10：检查 + 派发放在同一把锁里，两个并发请求不能同时通过 ocRunning()
        if (!tryLock('offclean-dispatch', 15000)) return 发(res, 409, { ok: false, error: '另一个清理派发正在进行' })
        try {
          if (req.method !== 'POST') return 发(res, 405, { ok: false, error: 'POST only' })
          if (!fs.existsSync(OFFCLEAN_SCRIPT)) return 发(res, 500, { ok: false, error: '找不到 offline-clean.mjs（应放 <DSH_HOME>/bin/ 或插件 bin/）' })
          if (ocRunning()) return 发(res, 409, { ok: false, error: '已有离线清理任务在运行（' + (ocReadJson(OFFCLEAN_LOCK) || {}).runId + '）' })
          const j = await ocBody(req)
          const dry = !!j.dry
          const d = new Date()
          const p = (n) => (n < 10 ? '0' : '') + n
          const runId = String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '-' + Math.random().toString(36).slice(2, 6)
          const mode = offCleanLaunch(runId, { dry, skipArchiveClean: j.skipArchiveClean, restartMode: j.restartMode })
          log('离线清理已派发：runId=' + runId + ' mode=' + mode + (dry ? '（dry-run 预检）' : '（将关闭 DSH，清理后自动拉起）'))
          return 发(res, 200, { ok: true, runId, dry, mode, script: OFFCLEAN_SCRIPT })
        } catch (e) {
          const code = /systemd-run/.test(String(e?.message ?? e)) ? 409 : 500
          return 发(res, code, { ok: false, error: String(e?.message ?? e) })
        } finally { releaseLock('offclean-dispatch') }
      },
    }))
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-log-prune/offclean/runs',
      handler: async (req, res) => {
        if (!guard(req, res, loadConfig())) return
        try {
          if (req.method !== 'GET') return 发(res, 405, { ok: false, error: 'GET only' })
          const running = ocRunning()
          const lk = running ? ocReadJson(OFFCLEAN_LOCK) : null
          const st = lk ? ocReadJson(path.join(OFFCLEAN_DIR, lk.runId, 'status.json')) : null
          return 发(res, 200, { ok: true, running, runId: lk ? lk.runId : '', status: st, runs: ocListRuns() })
        } catch (e) { return 发(res, 500, { ok: false, error: String(e?.message ?? e) }) }
      },
    }))
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-log-prune/offclean/run',
      handler: async (req, res) => {
        if (!guard(req, res, loadConfig())) return
        try {
          if (req.method !== 'GET') return 发(res, 405, { ok: false, error: 'GET only' })
          const u = new URL(req.url, 'http://localhost')
          const id = String(u.searchParams.get('id') || '')
          if (!/^[\w.\-]+$/.test(id)) return 发(res, 400, { ok: false, error: '非法 run id' })
          const dir = path.join(OFFCLEAN_DIR, id)
          if (!fs.existsSync(dir)) return 发(res, 404, { ok: false, error: '没有这个运行记录' })
          const full = u.searchParams.get('full') === '1'
          let logText = ''
          try { logText = fs.readFileSync(path.join(dir, 'run.log'), 'utf8') } catch {}
          // E7：简报已移到 brief.txt；旧的 run.log 首行简报保持兼容
          if (logText.indexOf('简报：') !== 0) {
            try { const brief = fs.readFileSync(path.join(dir, 'brief.txt'), 'utf8'); if (brief) logText = brief + logText } catch {}
          }
          if (!full) { const ls = logText.split('\n').filter(Boolean); if (ls.length > 400) logText = '（仅最近 400 行，加参数 full=1 看全部）\n' + ls.slice(-400).join('\n') }
          return 发(res, 200, { ok: true, id, status: ocReadJson(path.join(dir, 'status.json')), report: ocReadJson(path.join(dir, 'report.json')), log: logText })
        } catch (e) { return 发(res, 500, { ok: false, error: String(e?.message ?? e) }) }
      },
    }))
  } catch (e) { log('离线清理接口注册失败：' + (e?.message ?? e)) }
  // O5：会话体积分析（只读）——面板「体积」按钮的数据源
  if (!FLAGS.volumeRoute) try {
    FLAGS.volumeRoute = true
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-log-prune/volume',
      handler: async (req, res) => {
        if (!guard(req, res, loadConfig())) return
        try {
          if (req.method !== 'GET') return 发(res, 405, { ok: false, error: 'GET only' })
          const u = new URL(req.url, 'http://localhost')
          const sid = String(u.searchParams.get('sid') || '')
          if (!sid) return 发(res, 400, { ok: false, error: '缺 sid' })
          return 发(res, 200, await analyzeSessionVolume(sid))
        } catch (e) { return 发(res, 500, { ok: false, error: String(e?.message ?? e) }) }
      },
    }))
  } catch (e) { log('体积分析接口注册失败：' + (e?.message ?? e)) }
  // 每日自动清理：按配置里的时/分（默认 04:30）派发离线清理；每分钟对一次表，改配置即时生效
  // 2026-11-21 事故：当天标记只存在内存里，offline-clean 重启 DSH 后清空，
  // 6 小时补跑窗口内每分钟重派一次 → 反复重启。现在改为落盘认领 + 20 小时最小间隔（lib/offclean-day.mjs）。
  if (!FLAGS.dailyClean) try {
    FLAGS.dailyClean = true
    let lastSkip = ''
    let lastPlanLog = ''
    const p2 = (n) => (n < 10 ? '0' : '') + n
    const CLEAN_LAST = path.join(HOME, 'state', 'prune-clean-last.json')
    const unitNameOf = (day) => 'dsh-offclean-daily-' + day.replace(/-/g, '')
    const unitActive = (day) => {
      if (process.platform !== 'linux') return false
      try {
        const st = spawnSync('systemctl', ['is-active', '--quiet', unitNameOf(day)], { stdio: 'ignore', windowsHide: true, timeout: 5000 })
        return !st.error && st.status === 0
      } catch { return false }
    }
    const lockFresh = () => {
      try {
        const lk = JSON.parse(fs.readFileSync(OFFCLEAN_LOCK, 'utf8'))
        return !!(lk && lk.runId && Date.now() - (lk.updatedAt || 0) < 5 * 60000)
      } catch { return false }
    }
    let lastTickAt = Date.now()
    const tick = async () => {
      try {
        const nowMs = Date.now()
        // 两分钟以上没走 tick = 机器休眠/时钟跳变；这一轮只记日志，不补跑
        const resumed = nowMs - lastTickAt > 120000
        lastTickAt = nowMs
        const cfg = loadConfig()
        const now = new Date(nowMs)
        const day = dayKey(now)
        const last = readLastClean(CLEAN_LAST)
        const dec = decideDailyClean({ now, cfg, last, unitActive: unitActive(day) || lockFresh(), resumed })
        // 计划时间那一分钟强制留一行：即使原因和之前相同（比如今天已派过）也打，
        // 否则 lastSkip 去重会让「到点核对」在日志里完全看不见。
        const planMin = Number(cfg.cleanAtHour) * 60 + Number(cfg.cleanAtMinute)
        const atPlan = Number.isInteger(planMin) && minutesOfDayBJ(now) === planMin
        const planLogKey = day + '|' + planMin + '|plan'
        const logSkip = (reason) => {
          const k = day + '|' + reason
          const force = atPlan && planLogKey !== lastPlanLog
          if (k !== lastSkip || force) {
            lastSkip = k
            if (force) lastPlanLog = planLogKey
            log('每日离线清理跳过' + (force ? '（计划时间 ' + p2(Number(cfg.cleanAtHour)) + ':' + p2(Number(cfg.cleanAtMinute)) + '）' : '') + '：' + reason)
          }
        }
        if (!dec.ok) {
          logSkip(dec.reason)
        } else if (!claimDay(path.join(HOME, 'state'), day)) {
          logSkip('今天已有派发认领（跨重启不会重派）')
        } else {
          const attempt = Number((last && last.day === day && last.attempts) || 0) + 1
          const rec = { day, at: Date.now(), kind: 'offline', runId: dec.runId, phase: 'dispatching', attempts: attempt }
          writeLastClean(CLEAN_LAST, rec)
          try {
            const mode = offCleanLaunch(dec.runId, { dry: false })
            writeLastClean(CLEAN_LAST, { ...rec, phase: 'dispatched', mode })
            log('每日离线清理已派发（' + p2(Number(cfg.cleanAtHour)) + ':' + p2(Number(cfg.cleanAtMinute)) + '）：runId=' + dec.runId + ' mode=' + mode)
          } catch (e) {
            const msg = String(e?.message ?? e)
            // F12：环境类永久失败（脚本缺失 / node 不可用）不释放认领，避免反复关停 DSH；
            // systemd-run 抖动这类瞬时失败释放认领，下一分钟再试，最多 3 次。
            const transient = /systemd-run/.test(msg)
            const retry = transient && attempt < 3
            if (retry) { try { fs.unlinkSync(dayClaimPath(path.join(HOME, 'state'), day)) } catch {} }
            writeLastClean(CLEAN_LAST, { ...rec, phase: 'failed', transient, retryCount: retry ? attempt : 0, error: msg })
            log('每日离线清理派发失败' + (retry ? '（瞬时故障，稍后自动重试 ' + attempt + '/3）' : '（今天不再重试，可手工点面板）') + '：' + msg)
          }
        }
      } catch (e) { log('每日离线清理派发失败：' + (e?.message ?? e)) }
    }
    const schedule = () => {
      const next = new Date()
      next.setSeconds(0, 0)
      next.setMinutes(next.getMinutes() + 1)
      setTimeout(() => { tick().finally(schedule) }, Math.max(1000, next.getTime() - Date.now()))
    }
    // 不挂 ctx.effect 的清理函数：插件重载 dispose 时 clearTimeout 会把定时器清掉，
    // 而 FLAGS.dailyClean 已置位、新实例不会再注册 → 每日清理静默停摆。
    schedule()
  } catch (e) { log('每日清理调度注册失败：' + (e?.message ?? e)) }
  // 锁定会话：浏览器 localStorage 是主，落盘一份到本地；打开面板时从这里恢复（清过缓存/换浏览器用）
  if (!FLAGS.lockedRoute) try {
    FLAGS.lockedRoute = true
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-log-prune/locked',
      handler: async (req, res) => {
        if (!guard(req, res, loadConfig())) return;
        try {
          if (req.method === 'GET') {
            let ids = []
            try { const a = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); if (Array.isArray(a)) ids = a } catch {}
            return 发(res, 200, { ok: true, ids })
          }
          if (req.method !== 'POST') return 发(res, 405, { ok: false, error: 'GET/POST only' })
          let body = ''
          for await (const c of req) { body += c; if (body.length > 262144) break }
          let j = {}
          try { j = body ? JSON.parse(body) : {} } catch {}
          const ids = Array.isArray(j.ids) ? Array.from(new Set(j.ids.map(String).filter(Boolean))).slice(0, 500) : []
          try { fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true }); fs.writeFileSync(LOCK_FILE, JSON.stringify(ids)) } catch (e) {
            // O1：写盘失败不能回 ok:true，否则面板显示已保存、实际没落盘
            return 发(res, 500, { ok: false, error: '锁定列表写入失败：' + String(e?.message ?? e) })
          }
          return 发(res, 200, { ok: true, ids })
        } catch (e) { return 发(res, 500, { ok: false, error: String(e?.message ?? e) }) }
      },
    }))
  } catch (e) { log('锁定接口注册失败：' + (e?.message ?? e)) }

  // 熔断状态与解除：面板用它显示「是否熔断」，并允许一键解除（不用手工改 json）
  if (!FLAGS.fuseRoute) try {
    FLAGS.fuseRoute = true
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-log-prune/fuse',
      handler: async (req, res) => {
        if (!guard(req, res, loadConfig())) return;
        try {
          if (req.method !== 'GET') return 发(res, 405, { ok: false, error: 'GET only' })
          const u = new URL(req.url, 'http://localhost')
          const sid = String(u.searchParams.get('sid') || '')
          if (!sid) return 发(res, 400, { ok: false, error: '缺 sid' })
          const fz = readFuse()[sid] || null
          const st = readStatus()[sid] || null
          return 发(res, 200, { ok: true, fused: !!fz, at: fz ? fz.at : '', reason: fz ? fz.reason : '', status: st })
        } catch (e) { return 发(res, 500, { ok: false, error: String(e?.message ?? e) }) }
      },
    }))
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-log-prune/fuse/reset',
      handler: async (req, res) => {
        if (!guard(req, res, loadConfig())) return;
        try {
          if (req.method !== 'POST') return 发(res, 405, { ok: false, error: 'POST only' })
          let body = ''
          for await (const c of req) { body += c; if (body.length > 262144) break }
          const j = body ? JSON.parse(body) : {}
          const sid = String(j.sid || '')
          if (!sid) return 发(res, 400, { ok: false, error: '缺 sid' })
          if (!readFuse()[sid]) return 发(res, 200, { ok: true, removed: false, message: '本会话未熔断，无需处理' })
          // 解除前先修 + 复检：结构没修好就解除，下一轮裁切还会被核心拒绝
          let rep
          try { rep = await repairOrphans(sid) } catch (e) { rep = { ok: false, error: String(e?.message ?? e) } }
          if (!rep || !rep.ok) {
            const msg = String(rep?.error || '未知错误')
            // 正在运行的会话文件一直在变，修复不敢改写：退化为只读复检，结构没问题才允许解除
            if (msg.indexOf('一直在变') >= 0) {
              let chk0
              try { chk0 = await checkSession(sid, undefined, { force: true }) } catch (e) { chk0 = { ok: false, error: String(e?.message ?? e) } }
              if (chk0 && chk0.ok && !chk0.bad) {
                const removed0 = clearFuse(sid)
                log('解除熔断 ' + sid + '（运行中，只读复检通过）')
                return 发(res, 200, { ok: true, removed: removed0, repair: '会话正在运行，未改写文件；只读复检通过' })
              }
              return 发(res, 200, { ok: false, stage: 'verify', error: '会话正在运行，无法自动修复；只读复检：' + (chk0?.reason || chk0?.error || '有异常') })
            }
            return 发(res, 200, { ok: false, stage: 'repair', error: '自动修复失败：' + msg })
          }
          let chk
          try { chk = await checkSession(sid, undefined, { force: true }) } catch (e) { chk = { ok: false, error: String(e?.message ?? e) } }
          if (!chk || chk.ok === false) return 发(res, 200, { ok: false, stage: 'verify', error: '复检失败：' + (chk?.error || '未知错误'), repair: rep.message })
          if (chk.bad) return 发(res, 200, { ok: false, stage: 'verify', error: '修复后仍有问题：' + (chk.reason || '未知'), repair: rep.message })
          const removed = clearFuse(sid)
          // P4/L2：熔断解除时孤儿也修了，一并清掉面板提示（运行中只读复检那个分支不清）
          clearOrphanRisk(sid)
          log('解除熔断 ' + sid + '（先修复：' + rep.message + '）')
          return 发(res, 200, { ok: true, removed, repair: rep.message })
        } catch (e) { return 发(res, 500, { ok: false, error: String(e?.message ?? e) }) }
      },
    }))
  } catch (e) { log('熔断接口注册失败：' + (e?.message ?? e)) }

  // —— 设置面板：宿主给脚本路由 + 往页面注入（绕开 dsh.client 模块图）——
  if (!FLAGS.uiRoute) try {
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
    FLAGS.uiRoute = true;
  } catch (e) { log('面板路由失败：' + (e?.message ?? e)) }
  // 工具箱页签页：整页只渲染面板（ui.js 看到 ?embed=1 就不建浮窗）
  if (!FLAGS.panelRoute) try {
    FLAGS.panelRoute = true
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-log-prune/panel',
      handler: (req, res) => {
        try {
          // 带 token 打开：种 HttpOnly cookie 后 302 到不带 token 的同一地址，
          // 地址栏/历史/Referer 里不再留 token；刷新与同源 fetch 靠 cookie。
          try {
            const u = new URL(req.url || '/', 'http://127.0.0.1')
            const q = u.searchParams.get('token')
            if (q && q === lpToken()) {
              setTokenCookie(res, q)
              u.searchParams.delete('token')
              res.writeHead(302, { location: u.pathname + (u.search || ''), 'cache-control': 'no-store' })
              return res.end()
            }
          } catch {}
          const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            + '<title>日志裁切</title><style>html,body{margin:0;height:100%;background:#12161e;overflow:hidden}</style></head>'
            + '<body><script src="/dsh-log-prune/ui.js"></script></body></html>'
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(html)
        } catch (e) { try { res.writeHead(500); res.end('panel error') } catch {} }
      },
    }))
  } catch (e) { log('工具箱页签路由失败：' + (e?.message ?? e)) }
  try {
    ctx.on('webserver/index-inject', (table) => {
      if (!Array.isArray(table)) return
      // Q18 + B6：allowRemote 时注入 token；同时始终注入 postMessage 桥，
      // 让工具箱 iframe（独立 document）能向宿主页面要 token（iframe 拿不到 head 变量）。
      try {
        const tokenJs = loadConfig().allowRemote ? ('window.__LP_TOKEN__=' + JSON.stringify(lpToken()) + ';') : ''
        const bridge = 'window.addEventListener("message",function(e){'
          + 'if(e.origin!==location.origin||!e.data||e.data.type!=="lp-token-request")return;'
          + 'try{e.source.postMessage({type:"lp-token",token:window.__LP_TOKEN__||""},e.origin)}catch(_){}});'
        const has = table.some((r) => r && typeof r.text === 'string' && r.text.indexOf('lp-token-request') >= 0)
        if (!has) table.push({ kind: 'script', placement: 'head', text: tokenJs + bridge })
      } catch {}
      for (const row of table) {
        if (row && row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf('/dsh-log-prune/ui.js') >= 0) return
      }
      table.push({ kind: 'script', placement: 'body', text: 'var _lps=document.createElement("script");_lps.src="/dsh-log-prune/ui.js";document.body.appendChild(_lps);' })
    })
  } catch (e) { log('面板注入失败：' + (e?.message ?? e)) }
  (async () => {
    // 宿主树优先，其次裸 import（换安装路径/桌面版也能拿到），最后自建（带 id，核心只校验 id）
    let llm = null;
    try { llm = await fromHostTree('dsh-llm'); } catch {}
    if (!llm) { try { llm = await import('@deepseek-ai/dsh-llm'); log('dsh-llm：宿主树里没有，用自己依赖里那份'); } catch (e) { log('dsh-llm 拿不到：' + (e?.code || e?.message || e)) } }
    freezeMessage = llm?.freezeMessage ?? null;
    createUserMessage = llm?.createUserMessage ?? ((p) => {
      const q = p && typeof p === 'object' ? p : {};
      const m = { id: randomUUID(), role: 'user', content: Array.isArray(q.content) ? q.content : [] };
      if (q.source !== undefined) m.source = q.source;
      return m;
    });
    if (!llm) log('消息工厂：用自建实现（带 id）顶上了');
    // 安全闸（缺陷 5 修复）：拿不到宿主消息工厂就只量 token、一律不写会话。
    // 以前这里无条件置 true，等于闸门从来不存在。
    canWrite = Boolean(freezeMessage || createUserMessage);
    if (!canWrite) log('宿主消息工厂缺失：本轮只量 token、不裁')
    log((freezeMessage || createUserMessage ? '就绪' : '就绪（自建消息）') +
      '（摘要线 ' + SUMMARY_POINT + ' → 派摘要、落地后裁；硬线 ' + COMPACT_POINT + ' × ' + TRIGGER_RATIO + ' = ' + Math.round(COMPACT_POINT * TRIGGER_RATIO) +
      ' 兜底 → 裁到剩 ' + KEEP_TOKENS + '，保留最近 ' + KEEP_TURNS + ' 轮' + (DRY ? '，DRY' : '') + '）');
  })();

  // —— token 测量：三档兜底（2026-11-16 二次审查）——
  // ① 核心 token-meter 的 contextPressure：和 DSH 自己判断压缩用的是同一个数，
  //    口径就是 inputTokens + cacheReadTokens + cacheWriteTokens（dsh-token-meter:368）；
  //    它由核心按事件维护，不依赖我们扫表面，是最稳的一档。
  // ② 表面最近一条带 usage 的事件（同样的口径）——核心服务没装/改名时用这个。
  // ③ 全文字数 / 2 —— 只在完全没有 usage 时兜底，并且会在日志里标出来。
  // 2026-11-19：tokenMeter 是刻意软依赖（inject 未声明），取不到时按 usage→字数降级（见下）
  const measureTokens = (session, preNodes) => {
    try {
      const cp = ctx.get('tokenMeter')?.contextPressure?.(session);
      // projectedTokens 会把「表层刚被 shadow」的差额算进去；pressureTokens 是上一轮请求的旧值，裁切后会滞后一轮
      const p = cp?.projectedTokens ?? cp?.pressureTokens;
      if (typeof p === 'number' && p > 0) return { tokens: p, src: 'tokenMeter' };
    } catch {}
    try {
      const nodes = preNodes || collectNodes(session);
      for (let i = nodes.length - 1; i >= 0; i--) {
        const u = nodes[i].event?.data?.usage ?? nodes[i].event?.usage;
        if (!u) continue;
        const p = u.prompt_tokens ?? u.inputTokens;
        if (typeof p !== 'number') continue;
        const total = p + (u.cacheReadTokens ?? u.cache_read_tokens ?? 0) + (u.cacheWriteTokens ?? 0);
        if (total > 0) return { tokens: total, src: 'usage' };
      }
      let chars = 0;
      for (const n of nodes) chars += charLen(session.deriveEventMessage?.(n.event));
      if (chars > 0) return { tokens: Math.round(chars / 2), src: 'chars' };
    } catch {}
    return { tokens: 0, src: 'none' };
  };

  // 同会话裁切互斥：落地裁切和 pre-step 可能同时到，别让两边各裁一遍。
  // 2026-11-17：改成 globalThis 上的同一份集合——模块可能被加载多份（多个预设各挂一次），
  // 模块内 Set 各算各的，跨实例不互斥；两个实例同时裁同一会话正是会话损坏的头号原因。
  const pruning = globalThis.__dshLogPrunePruning || (globalThis.__dshLogPrunePruning = new Set());
  // O18：调试节流时间戳放实例闭包（以前挂 globalThis：多实例互相压制、热重载还残留）
  let dbgEntryAt = 0, dbgTickAt = 0, dbgDegAt = 0;
  // Q12：锁名用完整 sid 的哈希（以前截前 12 位 = "session-" + 4 位 hex，跨进程可能撞车）
  const pruneLockName = (sid) => 'prune-' + createHash('sha1').update(String(sid)).digest('hex').slice(0, 16);
  // 摘要落地看门（声明必须早于 pruneStep：它会在落地检测里用到，缺陷 9）
  const landingTimers = new Map();
  const landingMsgs = new Map();
  // 摘要保护日志去重：40 万以上 pruneStep 每 20 秒被调一次，无条件打会刷屏
  let lastSummaryGuard = '';
  const pruneStep = async (payload, next) => {
    try {
      if (Date.now() - (dbgEntryAt || 0) > 30000) {
        dbgEntryAt = Date.now();
        dlog('诊断入口：pre-step 触发，payload keys=' + Object.keys(payload || {}).join(',') + ' hasAgent=' + !!payload?.agent);
      }
    } catch {}
    const { agent } = payload || {};
    const sidLock = agent?.session?.id;
    if (sidLock && pruning.has(sidLock)) return next();
    // 跨实例锁：一个进程里可能挂着三份 log-prune，同一会话只让一份裁
    if (sidLock && !tryLock(pruneLockName(sidLock))) return next();
    if (sidLock) pruning.add(sidLock);
    try {
      const session = agent?.session;
      const sid = session?.id;
      if (!session || !sid) return next();
      const cfg = effectiveConfig(sid);

      const nodes = collectNodes(session);
      if (nodes.length < 8) return next();

      // 当前上下文规模：三档兜底（tokenMeter → usage → 字数）
      const measured = measureTokens(session, nodes);
      const tokens = measured.tokens;
      if (measured.src === 'chars' || measured.src === 'none') {
        if (Date.now() - (dbgDegAt || 0) > 300000) {
          dbgDegAt = Date.now();
          log('⚠ token 测量降级：tokenMeter/usage 都拿不到，只能用字数估算（src=' + measured.src + '）');
        }
      }
      // 全篇字数 + 实测 token 校准：影子价格用真实字/token 比，不再一律除以 2（缺陷 6）
      let allChars = 0;
      for (const n of nodes) allChars += charLen(session.deriveEventMessage?.(n.event));
      const perChar = tokens > 0 && allChars > 0 ? tokens / allChars : 0.5;
      const tok = (chars) => Math.round(chars * perChar);
      // 临时诊断：确认 pre-step 是否在跑、测到的 token 是多少（每 60 秒最多一行）
      if (Date.now() - (dbgTickAt || 0) > 60000) {
        dbgTickAt = Date.now();
        dlog('诊断：pre-step sid=' + String(sid).slice(0, 20) + ' nodes=' + nodes.length + ' tokens=' + tokens);
      }
      // 标定文件现在只留诊断用：峰值、压缩次数、索引块水位。阈值已写死，不再从峰值反推
      const calib = (() => { try { return JSON.parse(fs.readFileSync(CALIB_FILE, 'utf8')); } catch { return {}; } })();
      const c = calib[sid] ?? { peak: 0, ends: 0 };
      let ends = 0;
      for (const seq of [...session.surface.nodes]) if (session.eventAt(seq)?.type === 'compaction/end') ends++;
      if (ends > (c.ends ?? 0)) c.peak = tokens;
      c.ends = ends;
      if (tokens > (c.peak ?? 0)) c.peak = tokens;
      c.at = Date.now();
      calib[sid] = c;
      // 5.3：清掉 24 小时没更新过的会话条目（原来只增不减；旧条目没有 at 字段，不误删）
      for (const [k, v] of Object.entries(calib)) {
        if (k !== sid && v && typeof v.at === 'number' && Date.now() - v.at > 86400e3) delete calib[k];
      }
      try { fs.writeFileSync(CALIB_FILE, JSON.stringify(calib)); } catch {}
      dlog('检查 ' + sid.slice(0, 20) + ' tokens=' + tokens);
      // —— 摘要锚点扫描 + token 状态落盘（给 summary-watcher 用）——
      // messageText 已抽到 ./msgtext.mjs（5.2 拆分）
      // —— 长文落盘：单条 user 消息过长就写盘，面上只留一行指针 ——
      // 只动 user 消息（不涉及 assistant 的 tool 调用/结果配对），替换沿用裁切同款影子协议。
      let ltLimit = cfg.longtextLimit
      try {
        const low = JSON.parse(fs.readFileSync(path.join(HOME, 'state', 'prune-lowtest.json'), 'utf8'))[sid]
        if (low?.longtext) ltLimit = Number(low.longtext)
      } catch {}
      // 5.3：长文落盘目录按 plainKeepDays 清理过期日期目录（原来永不删除）
      try {
        const keepDays = Number(cfg.plainKeepDays || 30);
        if (keepDays > 0) {
          const cutoff = Number(dayOf(Date.now() - keepDays * 86400e3));
          for (const d of fs.readdirSync(LONGTEXT_ROOT)) {
            if (/^\d{8}$/.test(d) && Number(d) < cutoff) {
              try { fs.rmSync(path.join(LONGTEXT_ROOT, d), { recursive: true, force: true }); } catch {}
            }
          }
        }
      } catch {}
      const ltStateFile = path.join(LT_STATE_DIR, sid + '.json')
      let ltDone0 = []
      try { ltDone0 = JSON.parse(fs.readFileSync(ltStateFile, 'utf8')) } catch {}
      const ltDone = new Set(ltDone0)
      let ltCount = 0
      const ltOrder = [...session.surface.nodes]
      for (const seq of ltOrder) {
        if (!canWrite) break // 缺陷 5：写不了消息就不落盘（别留下只有文件没有指针的长文）
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
            // P4/H2：长文落盘也是 prune + 替换两条，失败同样会留孤儿
            let ltPrune = null;
            try {
              ltPrune = session.append('compaction/prune', {
                shadowedRange: { start: seq, end: seq },
                shadowedSeqs: [seq],
                shadowedTokenCount: Math.round(txt.length / 2),
              })
              session.append('user/message', msg, {
                surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
                sourceEventSeqs: [seq],
              })
            } catch (e) {
              // L1：不传 fails，保留主裁切的失败计数；S2：日志交给外层 per-seq catch
              if (ltPrune) {
                writeStatus(sid, {
                  reason: '长文落盘写入被拒：' + String(e?.message ?? e).slice(0, 160),
                  orphanRisk: {
                    seq: Number(ltPrune.seq) || 0,
                    range: seq + '-' + seq,
                    at: new Date().toISOString(),
                    reason: String(e?.message ?? e).slice(0, 200),
                  },
                })
              }
              throw e;
            }
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
      const surfaceOrder = [...session.surface.nodes]
      const summarySeq = scanSummarySeq(session)
      const lastSeqNow = surfaceOrder.length ? surfaceOrder[surfaceOrder.length - 1] : 0
      try {
        fs.mkdirSync(TOK_DIR, { recursive: true })
        fs.writeFileSync(path.join(TOK_DIR, sid + '.json'), JSON.stringify({ tokens, lastSeq: lastSeqNow, firstSeq: nodes[0]?.seq ?? 0, summarySeq, src: measured.src, at: Date.now() }))
      } catch {}
      if (!canWrite) { log('未就绪：宿主消息工厂缺失，本轮只记 token，不裁'); return next(); }
      // —— 只留摘要（2026-11-17 管理员定的两态机）——
      // 上弦：派发摘要时写文件（watcher 做）。上弦期间只判两件事：
      //   ① 上下文掉到摘要线一半以下 → 判为被别的方式清理过，取消上弦；
      //   ② 任务被 agent 领走（表面出现派发之后的任务消息）→ 进激发态。
      // 激发态：等下一次新内容（含 agent 自己的回复），定位摘要标题，把标题之前的全部换成门牌，成功即下弦。
      try {
        const armedFile = path.join(ARMED_DIR, sid + '.json')
        if (fs.existsSync(armedFile)) {
          const armed = readStateFile(armedFile)
          // 2026-11-17 修：等待类分支原来直接 return，改成「放行中层」时漏了「跳过表层裁切」这一步，
          // 结果摘要还没落地就带着旧摘要把内容裁了（11:38:48 实测）。用 skip 标志区分。
          let armedSkip = false
          // 进展刷新（2026-11-17 管理员定）：表面长了说明会话活着，超时计时重置；
          // 只有「一直没进展」才算任务丢了。避免人不在两小时就把弦断掉、回来白写摘要。
          if (armed.lastSeqSeen !== lastSeqNow) {
            armed.lastSeqSeen = lastSeqNow
            armed.at = Date.now()
            try { fs.writeFileSync(armedFile, JSON.stringify(armed)) } catch {}
          }
          const sumPoint = Number(cfg.summaryPoint || 0)
          // era 任务不适用「token 掉到摘要线一半 = 已被清理」的取消判定：
          // 时代合并处理的正是门牌堆积、token 不高的会话，误取消会让合并永远落不了地。
          if (sumPoint && tokens > 0 && tokens < sumPoint * 0.5 && !armed.era) {
            try { fs.unlinkSync(armedFile) } catch {}
            log('上弦取消：上下文 ' + tokens + ' < 摘要线一半 ' + Math.round(sumPoint * 0.5) + '，判定已被其他方式清理'); armedSkip = true
            try { writeStatus(sid, { ok: true, at: new Date().toISOString(), verify: 'armed-canceled', reason: '上下文已低于摘要线一半' }) } catch {}
          }
          const ageMin = Math.round((Date.now() - Number(armed.at || 0)) / 60000)
          if (ageMin > 120) {
            try { fs.unlinkSync(armedFile) } catch {}
            log('上弦超时（' + ageMin + ' 分钟）未落地，下弦'); armedSkip = true
          }
          const to0 = Number(armed.to || 0)
          let taskSeq = Number(armed.firedSeq || 0)
          if (!taskSeq) {
            for (const sq of surfaceOrder) {
              if (sq <= to0) continue
              const e2 = session.eventAt(sq)
              if (e2?.type !== 'user/message') continue
              const t2 = (session.deriveEventMessage?.(e2)?.content || []).filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n')
              if (t2.indexOf(TASK_MARK) >= 0) { taskSeq = sq; break }
            }
          }
          if (!taskSeq) { log('上弦中：等摘要任务被领走（覆盖到 seq ' + to0 + '）'); armedSkip = true }
          if (taskSeq && !armed.firedSeq) {
            armed.state = 'fired'; armed.firedSeq = taskSeq; armed.firedAt = Date.now()
            try { fs.writeFileSync(armedFile, JSON.stringify(armed)) } catch {}
            log('摘要任务已领走（seq ' + taskSeq + '），进入激发态，等下一次新内容')
          }
          // 摘要识别（2026-11-17 放宽）：优先用严格判据（以「【裁切摘要】」开头）；
          // 模型若加了前言、或只写在 reasoning 里，严格判据会永远等不到，于是补一条：
          // 派发之后新出现的 assistant 消息，正文里含「覆盖：seq A-B」也算落地。
          let summarySeqEff = summarySeq
          if (!(summarySeqEff > to0)) {
            for (const sq of [...surfaceOrder].reverse()) {
              if (sq <= to0) break
              const e4 = session.eventAt(sq)
              if (e4?.type !== 'assistant/message') continue
              // 2026-11-19 T3 修复：只认 text 块；正文为空（只含 reasoning）的消息不算落地
              const t4 = (session.deriveEventMessage?.(e4)?.content || [])
                .filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n')
              if (!t4.trim()) continue
              if (t4.indexOf('【裁切摘要】') >= 0 || /覆盖\s*[：:]\s*seq\s*\d+\s*-\s*\d+/.test(t4)) { summarySeqEff = sq; break }
            }
          }
          if (!(summarySeqEff > to0)) {
            log('激发态：摘要未落地（summarySeq=' + summarySeq + '，需 > ' + to0 + '），继续等'); armedSkip = true
          }
          if (!armedSkip) {
          // 一次性替换：整段「表面首节点 … 摘要前一个节点」，不循环、不拆段。
          // 表面里夹着后插入的门牌，seq 可能倒序，所以不强制递增，sourceEventSeqs 按表面实际顺序传。
          const order2 = [...session.surface.nodes]
          const i2 = order2.indexOf(summarySeqEff)
          // 节点 0 是系统提示词：核心只允许用 system/message 整体覆盖它，普通 user/message 会被拒
          // （2026-11-17 实测：surface replace: node 0 holds the system prompt…）。所以从节点 1 起裁。
          const startIdx = order2.length && session.eventAt(order2[0])?.type === 'system/message' ? 1 : 0
          if (i2 <= startIdx) { try { fs.unlinkSync(armedFile) } catch {}; log('只留摘要：摘要已在最前，无需裁'); return next() }
          const ex = order2.slice(startIdx, i2)
          const cutStart = ex[0], cutEnd = order2[i2 - 1]
          // 门牌区间继承（2026-11-18 方案1）：不只 parse ex 首节点——要扫区间内 + 会话日志里的旧门牌，
          // 沿链取最早起点并累加条数，否则旧门牌被吸收后它声明的更早区间（如 106165-109466）会断档。
          let aSeq2 = cutStart, bSeq2 = cutEnd, plateCount = ex.length
          try {
            const plates = []
            const seen = new Set()
            const addPlate = (seq) => {
              if (seen.has(seq)) return
              seen.add(seq)
              const ev = session.eventAt(seq)
              if (!ev || ev.type !== 'user/message') return
              const p = parsePlate(session.deriveEventMessage?.(ev))
              if (p && p.start > 0 && p.end >= p.start) plates.push({ seq, ...p })
            }
            for (const sq of ex) addPlate(sq)
            try {
              if (session.events && typeof session.events.values === 'function') {
                for (const ev of session.events.values()) {
                  if (ev && ev.type === 'user/message' && ev.seq <= cutEnd) addPlate(ev.seq)
                }
              }
            } catch {}
            const chain = mergePlateChain(plates, cutStart, ex.length)
            if (chain.start > 0 && chain.start < aSeq2) { aSeq2 = chain.start; plateCount = chain.count }
          } catch {}
          let shadowTotal = 0
          for (const sq of ex) shadowTotal += tok(charLen(session.deriveEventMessage?.(session.eventAt(sq))))
          const d2 = new Date()
          const ds2 = d2.getFullYear() + '-' + String(d2.getMonth() + 1).padStart(2, '0') + '-' + String(d2.getDate()).padStart(2, '0')
          const text2 = '[' + ds2 + ' 全天记录已归档 · ' + plateCount + ' 条 · 原文 归档/会话日志 · seq=' + aSeq2 + '-' + bSeq2 +
            ' · 找内容：log_prune_search("关键词")；取全文：log_prune_read(' + aSeq2 + ',' + bSeq2 + ')（编号可能被外部清理工具重排）]'
          const msg2 = buildUserMessage([{ type: 'text', text: text2 }], { kind: 'user', rpcId: 'prune-onlysummary-' + cutStart + '-' + cutEnd })
          // 2026-11-18 补：摘要路径与自动裁切共用同一道闸门——先确认原文已另存，补不上就不裁
          {
            const ar = await ensureArchived(sid, bSeq2, { log, fromSeq: aSeq2 })
            if (!ar.ok) {
              log('归档未就绪，暂不裁（摘要路径）：' + ar.why)
              try { writeStatus(sid, { ok: false, at: new Date().toISOString(), reason: 'archive-missing', detail: ar.why, fails: 0 }) } catch {}
              return next()
            }
            if (ar.ran) log('摘要路径已补归档到 seq ' + bSeq2 + '（' + ar.why + '）')
          }
          try {
            session.append('compaction/prune', { shadowedRange: { start: cutStart, end: cutEnd }, shadowedSeqs: ex, shadowedTokenCount: shadowTotal })
            session.append('user/message', msg2, { surfaceOp: { op: 'replace', startSeq: cutStart, endSeq: cutEnd }, sourceEventSeqs: ex })
          } catch (e) {
            const why = String(e?.message ?? e).slice(0, 200)
            // 被拒时 prune 已经写进去了，会留下孤儿并让会话加载校验失败（2026-11-17 实测：测试会话打不开）。
            // 但**会话正在本进程里开着**时不能修：内存里是旧副本，重启/回写会把文件整份覆盖，
            // 修了也白修（2026-11-17 事故）。这种情况只记日志，交给「停服后修」。
            const busy = (() => {
              try {
                const root = path.join(HOME, 'sessions')
                for (const ws of fs.readdirSync(root)) {
                  try {
                    const dir = path.join(root, ws, String(sid))
                    const st = fs.statSync(path.join(dir, sessionFileName(dir)))
                    return Date.now() - st.mtimeMs < 60e3
                  } catch {}
                }
              } catch {}
              return true
            })()
            if (busy) log('孤儿未自动修：会话刚被写过（进程内存里还有旧副本），需停服后修')
            else { repairOrphans(sid).catch((e2) => log('孤儿修复失败：' + (e2?.message ?? e2))) }
            const tries = Number(armed.tries || 0) + 1
            if (tries >= 3) {
              try { fs.unlinkSync(armedFile) } catch {}
              log('只留摘要连续 3 次被拒，下弦：' + why)
            } else {
              try { fs.writeFileSync(armedFile, JSON.stringify({ ...armed, tries })) } catch {}
              log('只留摘要被拒（' + aSeq2 + '-' + bSeq2 + '，第 ' + tries + ' 次）：' + why)
            }
            return next()
          }
          try { fs.unlinkSync(armedFile) } catch {}
          // 轻索引（2026-11-17 补）：只留摘要这条路径原来不写索引，刚裁掉的内容搜不到也读不到。
          // arch 留空：这段内容当天还没日封；读取时按 seq 现查归档（loadArchive），日封后自动可读。
          try {
            const ents = []
            for (const sq of ex) {
              const ev = session.eventAt(sq)
              const m = session.deriveEventMessage?.(ev)
              const raw = messageText(m)
              if (!raw.trim()) continue
              ents.push({ seq: sq, time: ev?.time || Date.now(), role: m?.role || ev?.type || '?', type: ev?.type || '', text: raw, arch: '' })
            }
            const pc = effectiveConfig(sid)
            const cnt = plainWriter(sid, dayOf, ents, { maxChars: pc.plainMaxChars, keepDays: pc.plainKeepDays, idxKeepDays: pc.idxKeepDays, redact: pc.plainRedact, plainEnabled: pc.plainEnabled })
            if (cnt) dlog('明细索引 ' + cnt + ' 条 → ' + path.join(PLAIN_INDEX_DIR, sid))
          } catch (e) { log('明细索引写入失败：' + (e?.message ?? e)) }
          // 表层自己的验收标准（2026-11-17 管理员定）：只留摘要 = 摘要还在、它前面只剩系统提示词和门牌。
          const semantic = (() => {
            const surf2 = [...session.surface.nodes]
            const at2 = surf2.indexOf(summarySeqEff)
            if (at2 < 0) return { ok: false, why: '摘要不在表面' }
            const before = surf2.slice(0, at2)
            const bad = before.filter((sq) => {
              const e3 = session.eventAt(sq)
              if (e3?.type === 'system/message') return false
              return !isPlaceholder(session.deriveEventMessage?.(e3))
            })
            if (bad.length) return { ok: false, why: '摘要前仍有 ' + bad.length + ' 条内容', seqs: bad.slice(0, 5) }
            return { ok: true, kept: before.length }
          })()
          if (!semantic.ok) log('表层验收未通过：' + semantic.why + '（seq ' + (semantic.seqs || []).join(',') + '）')
          // 验收只保留语义这一条（2026-11-17）：checkSession(force) 用「最终表面」校验历史 prune，
          // 被替换过的历史段永远对不上，必然误判；而且每次都要解压整份会话。
          // 成功必须把上一次的 archive-missing/detail 清掉；这里以前只写 ok，
          // 面板会一直显示「归档缺失」，尽管这一刀已经成功。
          writeStatus(sid, { ok: true, fails: 0, reason: '', detail: '', at: new Date().toISOString(), summarySeq: summarySeqEff, cut: aSeq2 + '-' + bSeq2, saved: shadowTotal, verify: semantic.ok ? 'ok' : 'semantic: ' + semantic.why })
          // 2026-11-19 T3 修复：只留摘要路径原来只写 prune-status，不写 prune-last，
          // 导致「同一摘要刚裁过」判断和外部对账都看不到这次裁切。与中层分支同源记账。
          try {
            const all = readStateFile(PRUNED_FILE)
            all[sid] = { summarySeq: summarySeqEff, tailSeq: lastSeqNow, at: Date.now() }
            fs.writeFileSync(PRUNED_FILE, JSON.stringify(all))
          } catch (e) { log('prune-last 写入失败：' + (e?.message ?? e)) }
          // 把新摘要写回 token 状态：下一轮判据别再用旧值（watcher/中层都读这个文件）
          try {
            let st2 = {};
            try { st2 = JSON.parse(fs.readFileSync(path.join(TOK_DIR, sid + '.json'), 'utf8')) } catch {}
            st2.summarySeq = summarySeqEff
            st2.lastSeq = summarySeqEff
            st2.tokens = Math.max(0, Number(st2.tokens || 0) - shadowTotal)
            st2.src = 'postOnlySummary'
            st2.at = Date.now()
            fs.writeFileSync(path.join(TOK_DIR, sid + '.json'), JSON.stringify(st2))
          } catch {}
          log('只留摘要：裁掉 ' + ex.length + ' 个节点（seq ' + aSeq2 + '-' + bSeq2 + '），省约 ' + shadowTotal + ' token')
          return next()
          } // !armedSkip
        }
      } catch (e) { log('上弦检查失败：' + (e?.message ?? e)) }
      // 走 HTTP 派发时没有 inbox/inserted 事件：在这里补一个落地检测
      try {
        const reqNow = readStateFile(REQ_FILE)[sid]
        if (reqNow && typeof reqNow.lastSeq === 'number' && !(summarySeq > reqNow.lastSeq) && !landingTimers.has(sid)) watchLanding(agent)
      } catch {}
      // 同一份摘要刚裁过、表面也没变化 → 不重复裁
      const lastPruned = readStateFile(PRUNED_FILE)[sid]
      if (lastPruned && summarySeq && lastPruned.summarySeq === summarySeq &&
          lastPruned.tailSeq === lastSeqNow && Date.now() - (lastPruned.at || 0) < 60000) {
        log('同一摘要刚裁过（seq ' + summarySeq + '），跳过')
        return next()
      }
      const fuse = readFuse()[sid];
      if (fuse) { log('熔断中，跳过 ' + sid + '（' + fuse.at + '：' + fuse.reason + '）'); return next(); }
      // 单会话测试覆盖：$DSH_HOME/state/prune-lowtest.json {"<sid>": {compact, keepTokens, ratio}}
      let compactPoint = cfg.compactPoint, keepTokens = cfg.keepTokens, triggerRatio = cfg.triggerRatio, summaryTrigger = cfg.summaryTrigger;
      try {
        const low = JSON.parse(fs.readFileSync(path.join(HOME, 'state', 'prune-lowtest.json'), 'utf8'))[sid];
        if (low) {
          compactPoint = Number(low.compact ?? compactPoint);
          keepTokens = Number(low.keepTokens ?? keepTokens);
          triggerRatio = Number(low.ratio ?? triggerRatio);
          summaryTrigger = Number(low.summaryTrigger ?? summaryTrigger);
          log('低阈值测试覆盖：压缩点 ' + compactPoint + ' × ' + triggerRatio + '，保留 ' + keepTokens);
        }
      } catch {}
      const TRIGGER_TOKENS = Math.round(compactPoint * triggerRatio);
      // 有摘要：到 summaryTrigger 就裁，裁掉摘要前的一切；没摘要：走强制兜底线，保留 keepTokens
      // 2026-11-17 管理员纠正：强制裁切恒用硬线（55 万），不看有没有摘要。
      // 原来写成 summarySeq ? min(硬线, summaryTrigger) : 硬线，把兜底线降到 40 万，
      // 与摘要线重合，15 万缓冲区被吃掉，还和派摘要抢跑。summaryTrigger 只影响摘要，不影响裁切。
      const triggerNow = TRIGGER_TOKENS;
      // 强制裁切只有一条判据：到硬线（55 万）。
      // 原来还有一条「最近 5 轮有摘要就不看到线直接裁」的旁路，那是给旧流程用的；
      // 现在正常流程走「上弦 + 只留摘要」，这条旁路会把兜底线再拉低一次，一并删掉（2026-11-17）。
      if (tokens < triggerNow) { if (tokens) dlog('未触发：' + tokens + '/' + triggerNow); return next(); }
      // 外部改动检测（缺陷 1 修复）：dsh-session-vacuum 之类会重写会话文件（删碎片 + 重排 seq）。
      // 旧判据「2 分钟内被写过」在活跃会话里恒为真（每个 step 都在写），等于永久禁止裁切。
      // 新判据：同一路径的 inode 变了、或文件比我们上次看到的小了 —— 那才是被重写过。
      try {
        const lp = sessionLogPath(sid)
        if (lp) {
          const st = fs.statSync(lp)
          const prevStamp = logStamp.get(sid)
          logStamp.set(sid, { ino: st.ino, size: st.size })
          // Q15：部分 Windows 文件系统（FAT 等）ino 恒为 0，这时只比体积
          const inoKnown = st.ino > 0 && (prevStamp?.ino ?? 0) > 0
          if (prevStamp && ((inoKnown && prevStamp.ino !== st.ino) || st.size < prevStamp.size)) {
            log('会话文件被外部重写（inode ' + prevStamp.ino + '→' + st.ino + '，体积 ' + prevStamp.size + '→' + st.size + '），跳过本轮裁切')
            return next()
          }
        }
      } catch {}


      // 覆盖面：先认正式归档包，再认实时镜像（镜像也是事件 JSONL，逐行解析过才算）
      const archiveMap = loadArchive(sid, cfg.archiveDir || ARCHIVE_DIR);
      const mirrorMap = loadMirror(sid, cfg.mirrorDir || MIRROR_DIR);
      // O10：归档可能是区间代理（有 seqs.json 时不解压），用组合视图统一 has/get/set/size/values
      const archived = new ArchiveView(mirrorMap, archiveMap);
      const coveredByArchive = archived.size;
      // 归档/镜像可能只覆盖到某一天（本机 log-mirror 从 2026-11-15 21:36 起就没再写，
      // 镜像和归档都停在 seq 71382）。以前只有「一个都没有」才走会话日志兜底，
      // 于是今天的内容全被判成"未归档"→ 一轮都裁不了（2026-11-16 实测：摘要之后没有可裁段）。
      // 现在按缺口补齐：会话日志本身就是 DSH 写的原文，缺哪段补哪段。
      try {
        const logMap = await loadSessionLog(sid);
        if (logMap.size) {
          for (const [k, v] of logMap) if (!archived.has(k)) archived.set(k, v);
          if (archived.size > coveredByArchive) {
            log('原文覆盖补齐：镜像/归档 ' + coveredByArchive + ' 条 + 会话日志补 ' + (archived.size - coveredByArchive) + ' 条');
          }
        }
      } catch (e) { log('会话日志兜底失败：' + (e?.message ?? e)) }
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
        perDay[d] = (perDay[d] ?? 0) + tok(charLen(session.deriveEventMessage?.(nn.event)));
      }
      const pastDays = Object.values(perDay).slice(-7);
      const avgDaily = pastDays.length ? Math.round(pastDays.reduce((a, b) => a + b, 0) / pastDays.length) : 0;
      const winDays = plateWindowDays(keepTokens, avgDaily);
      const cutoffDay = dayOf(Date.now() - (winDays - 1) * 86400e3);
      const isPlate = (seq) => isPlaceholder(session.deriveEventMessage?.(session.eventAt(seq)));
      // —— 摘要覆盖保护（2026-11-10 管理员定）——
      // 只在「摘要块」覆盖到的位置之前裁；摘要本身和它之后的轮次不动，
      // 中层（强制裁切）只做一件事：触线即斩，保留 10 万、最近 3 轮。
      // 2026-11-17 管理员定：保留量/范围不许随摘要变——那是表层（只留摘要）的活，表层有自己的验收标准。
      const keepTurnsNow = cfg.keepTurns
      const keepTokensNow = keepTokens

      // 按 token 预算挑：从最早一轮往后累加，剩到保留线就停
      const spans = selectCutSpans(turns, {
        summarySeq: 0,
        tokens,
        archived: (s) => archived.get(s),
        keepTurns: keepTurnsNow,
        keepTokens: keepTokensNow,
        isPlate,
        shadowOf: (t) => {
          let ch = 0;
          for (const seq of t.seqs) ch += charLen(session.deriveEventMessage?.(session.eventAt(seq)));
          return tok(ch);
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
      // 中层不按摘要边界裁剪（那是表层的活）；只跳过「刚好包含摘要节点」的那一段，别把锚点切掉。
      if (summarySeq) {
        const before = spans.length
        for (let i = spans.length - 1; i >= 0; i--) {
          const s = spans[i]
          if (summarySeq >= s.startSeq && summarySeq <= s.endSeq) spans.splice(i, 1)
        }
        if (before !== spans.length) log('中层跳过含摘要节点的段 ' + (before - spans.length) + ' 个（锚点不切）')
      }
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
          const src = { kind: 'user', rpcId: 'prune-index-' + Date.now() };
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
        // 2026-11-16 修：原来只看 user/message，而真摘要是 assistant/message，等于从没保护过；
        // 以前打印的「剔除 N 个」剔的是任务提示词（误伤）。现在两个角色都覆盖。
        const summaryInSpan = spanSeqs.filter((s) => {
          const ev = session.eventAt(s)
          if (!ev) return false
          if (ev.type !== 'user/message' && ev.type !== 'assistant/message') return false
          return isSummaryText(session.deriveEventMessage?.(ev)?.content)
        })
        if (summaryInSpan.length) {
          log('区间含摘要块，剔除 ' + summaryInSpan.length + ' 个节点')
          spanSeqs = spanSeqs.filter((s) => !summaryInSpan.includes(s))
          if (!spanSeqs.length) continue
          // 挖掉节点后末位可能落在工具调用/结果中间，配对就破了（核心会拒，连拒三次熔断）
          if (!balancedUpTo(order, session, spanSeqs[spanSeqs.length - 1], hasToolCallEvents)) {
            log('剔除摘要后配对不平，跳过 ' + span.startSeq + '-' + span.endSeq)
            continue
          }
        }
        const endSeq = spanSeqs[spanSeqs.length - 1];
        let chars = 0, shadow = 0;
        for (const seq of spanSeqs) {
          const ev = session.eventAt(seq);
          const m = session.deriveEventMessage?.(ev);
          const c = charLen(m);
          chars += c;
          shadow += tok(c);
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
            if ((candEv?.type === 'user/message' || candEv?.type === 'assistant/message')
              && isSummaryText(session.deriveEventMessage?.(candEv)?.content)) continue;
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
        // 起始位置上常挂着「非内容」节点：官方压缩摘要节点、我们自己的门牌（都带 surfaceOp.replace）。
        // 它们的 seq 比后继都新（替换操作总是追加新事件到旧位置），会让「严格递增」检查整段失败。
        // 例：surface = [80633 压缩摘要, 83195 门牌, 83079 真实消息, …] → 83195 > 83079。
        // 处理：跳过开头的合成节点（以及 seq 不递增的残留），从第一个真实内容节点开始切。
        // 2026-11-16 补（副本实测发现）：跳过之后 replaceStart 会往后移，门牌上的起点必须跟着换——
        // 原来用 span.startSeq 写区间，于是新门牌写着 80633，实际只替换了 83079 之后，旧门牌还留在面上，
        // 同一出现了 483 条(80633-83072)、25 条(80633-83190) 两个区间重叠的门牌。
        const isSynthetic = (s) => {
          const ev = session.eventAt(s);
          if (!ev) return true;
          if (ev.surfaceOp && ev.surfaceOp.op === 'replace') return true;
          return isPlaceholder(session.deriveEventMessage?.(ev));
        };
        const iB0 = order.indexOf(endSeq);
        let iA0 = order.indexOf(replaceStart);
        // 门牌合并：旧门牌的 seq 早于本段终点时才可并入（否则 DSH 会拒「起点不是更早的事件」）。
        // 门牌是替换节点，seq 通常比右侧内容新，所以合并时还要放开后面的严格递增检查。
        const plan = decidePlateMerge(order, iA0, iB0, prevPlate ? prevPlate.seq : null, endSeq, isSynthetic,
          (s) => isSummaryText(session.deriveEventMessage?.(session.eventAt(s))?.content),
          (s) => session.eventAt(s)?.type === 'system/message',
          cfg.plateMerge ?? PLATE_MERGE);
        const mergePlate = plan.mergePlate;
        iA0 = plan.iA0;
        const skippedLead = plan.skippedLead;
        if (skippedLead) log('跳过起始合成节点 ' + skippedLead + ' 个（压缩摘要/门牌，seq 不递增）');
        if (iA0 >= 0) replaceStart = order[iA0];
        // 旧门牌被跳过、没并进替换范围：不借它的区间和条数（借了就是两个门牌写同一段）
        // O6（2026-11-18）：合并模式下 replaceStart 故意指向「门牌左边的真实节点」，与 prevPlate.seq 不同是正常的；
        // 这里若无脑清空，合并分支永远拿不到 prevPlate → 条数缩水、起点不覆盖旧区间、日志也不打印。
        if (!mergePlate && prevPlate && prevPlate.seq !== replaceStart) prevPlate = null;
        if (mergePlate && !prevPlate) log('warn：mergePlate 但 prevPlate 被清空（前置条件变了，检查 decidePlateMerge）');
        if (mergePlate && prevPlate) log('合并旧门牌 seq ' + prevPlate.seq + '（区间起点 ' + replaceStart + '）');
        const iStart = order.indexOf(replaceStart);
        const okStart = iStart <= 0 ? true : balancedUpTo(order, session, order[iStart - 1], hasToolCallEvents);
        if (!okStart) { log('起点不平整，跳过 ' + replaceStart); continue; }
        // 收集本段里的长文落盘标记，跟门牌一起留一行，裁切后还能找回
        const ltList = [];
        const iEnd = Math.max(iStart, order.indexOf(endSeq));
        const cutCount = iEnd - iStart + 1;
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
              (prevPlate?.count ?? 0) + cutCount,
              prevPlate?.file ?? archived.get(span.startSeq)?.file ?? '',
              sid,
              Math.min(prevPlate?.start ?? replaceStart, replaceStart),
              Math.max(prevPlate?.end ?? endSeq, endSeq),
              ltList.slice(0, 5),
            );
        if (DRY) {
          log('DRY 会裁 ' + prettyDay(span.day) + ' seq ' + span.startSeq + '-' + span.endSeq + '（' + chars + ' 字）');
          saved += shadow; n++;
          continue;
        }
        // 2026-11-18：裁切前确认原文已经另存（归档文件），没覆盖就现场补一次；补不上就不裁。
        // 这不是性能路径——只在真要落刀时走一次，已覆盖就直接返回。
        {
          const ready = await ensureArchived(sid, endSeq, { log, fromSeq: span.startSeq });
          if (!ready.ok) {
            log('归档未就绪，跳过本轮裁切：' + ready.why);
            try { writeStatus(sid, { ok: false, at: new Date().toISOString(), reason: 'archive-missing', detail: ready.why, fails: 0 }) } catch {}
            break;
          }
          if (ready.ran) log('已补归档到 seq ' + endSeq + '（' + ready.why + '）');
        }
        const blocks = [{ type: 'text', text }];
        const src = { kind: 'user', rpcId: 'prune-' + span.startSeq + '-' + endSeq };
        const message = buildUserMessage(blocks, src);
        const key = sid + ':' + replaceStart + '-' + endSeq;
        if (done.has(key)) { log('这段已经裁过，跳过 ' + key); continue; }
        // 区间列表就是当前运行时表面的一段（核心自动维护，不信自己重放的）
        let _iA = order.indexOf(replaceStart), _iB = order.indexOf(endSeq);
        if (_iA < 0 || _iB < _iA) {
          log('区间端点不在当前表面，跳过 ' + replaceStart + '-' + endSeq);
          continue;
        }
        // 合成起始节点的跳过已在上方（门牌文字要用最终 replaceStart，所以提前到那里做）
        // O11（2026-11-18）：order 已经是真实表面快照，重放结果必然一致；这段只在诊断时跑
        if (DEBUG) {
          const replayGuess = replaySurfaceSpan((s) => session.eventAt(s), replaceStart, endSeq);
          if (replayGuess && (replayGuess.length !== _iB - _iA + 1 ||
              replayGuess.some((s, k) => s !== order[_iA + k]))) {
            log('重放与表面不一致（' + replaceStart + '-' + endSeq + '），以表面为准');
          }
        }
        const exact = order.slice(_iA, _iB + 1);
        // 表面顺序必须严格递增（seq 升序）：有序性被破坏时跳过，绝不写倒序门牌
        // 合并门牌时区间里必然出现「门牌 seq 比后一条大」的非单调，这是替换节点的正常形态；
        // 只在非合并模式下坚持严格递增（宁可不裁，也不写倒序区间）。
        // O8（2026-11-18）：合并模式下只容忍「旧门牌 seq 比它左边节点大」这一条边，其余仍严格递增
        const badOrder = exact.some((s, k) => {
          if (k === 0 || s > exact[k - 1]) return false;
          if (mergePlate && prevPlate && s === prevPlate.seq) return false;
          return true;
        });
        if (badOrder) {
          log('表面顺序异常（' + replaceStart + '-' + endSeq + '），跳过本次裁切');
          continue;
        }
        let eChars = 0, eShadow = 0;
        for (const seq of exact) {
          const m = session.deriveEventMessage?.(session.eventAt(seq));
          const c = charLen(m); // P13 补完：同一条消息别算两遍（exact 循环上一轮漏改）
          eChars += c;
          eShadow += tok(c);
        }
        if (eChars < 200) { log('精确区间太短，跳过 ' + replaceStart + '-' + endSeq); continue; }
        // 影子价格协议：compaction/prune 紧挨在替换事件前面。
        // 替换被拒就会留下孤儿 prune，所以失败立刻停手，别连着重试
        // P4/H1：抓住 prune 事件的返回值——append 返回 deepFreeze 的事件对象（含 seq），
        // 只有它成功、随后的替换被拒，才真的留下孤儿；prune 本身被拒时没有孤儿。
        let pruneEv = null;
        try {
          pruneEv = session.append('compaction/prune', {
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
          const 原因 = String(e?.message ?? e).slice(0, 200);
          if (pruneEv) {
            writeStatus(sid, {
              ok: false, fails: failCount, reason: 原因,
              orphanRisk: {
                seq: Number(pruneEv.seq) || 0,
                range: replaceStart + '-' + endSeq,
                at: new Date().toISOString(),
                reason: 原因,
              },
            });
            log('替换被拒，留下孤儿 prune seq=' + (pruneEv.seq ?? '?') +
              '（第 ' + failCount + ' 次）：' + replaceStart + '-' + endSeq + '：' + (e?.message ?? e));
          } else {
            writeStatus(sid, { ok: false, fails: failCount, reason: 原因 });
            log('prune 事件被拒（无孤儿，第 ' + failCount + ' 次）：' + replaceStart + '-' + endSeq + '：' + (e?.message ?? e));
          }
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
        writeStatus(sid, { ok: true, fails: 0, reason: '', detail: '' });
        markDone(key);
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
        // 轻索引：检索工具用（首句 + 显著词 + 归档文件）；原文仍在归档，零额外解压
        if (!DRY) {
          try {
            const ents = []
            for (const s of exact) {
              const ev = session.eventAt(s)
              const m = session.deriveEventMessage?.(ev)
              const raw = messageText(m)
              if (!raw.trim()) continue
              ents.push({ seq: s, time: ev?.time || Date.now(), role: m?.role || ev?.type || '?', type: ev?.type || '', text: raw, arch: (archived.get(s)?.file) || '' })
            }
            const pc = effectiveConfig(sid)
            const cnt = plainWriter(sid, dayOf, ents, { maxChars: pc.plainMaxChars, keepDays: pc.plainKeepDays, idxKeepDays: pc.idxKeepDays, redact: pc.plainRedact, plainEnabled: pc.plainEnabled })
            if (cnt) dlog('明细索引 ' + cnt + ' 条 → ' + path.join(PLAIN_INDEX_DIR, sid))
          } catch (e) { log('明细索引写入失败：' + (e?.message ?? e)) }
        }
      }
      if (n) {
        log('裁了 ' + n + ' 段，省约 ' + saved + ' token（' + (DRY ? 'DRY' : '当前 ' + tokens + '）'));
        // 中层兜底动手了 → 表层这一轮没走完，主动下弦（2026-11-17 管理员定）。
        // 不下弦的话，上弦文件会一直挂着：watcher 不再派新摘要，等下一次 pre-step 才被
        // 「上下文掉到线一半以下」这条兜到，中间这段时间表层是僵尸状态。
        try {
          const af = path.join(ARMED_DIR, sid + '.json');
          if (!DRY && fs.existsSync(af)) {
            fs.unlinkSync(af);
            log('中层强制裁切后下弦（表层未完成，兜底已接管）');
          }
        } catch (e) { log('中层下弦失败：' + (e?.message ?? e)) }
        // 裁切刚落地时，prune-tokens 里还是「裁切前那一轮」的读数（它天然滞后一轮），
        // watcher 会拿旧数再判一次到线、白派一张摘要（2026-11-16 19:33 就这么发生了一次，
        // 一个 45 万输入的回合把刚省下的钱花掉大半）。这里把折算后的现值写回去，
        // 下一轮真实测量到来后再由它覆盖。
        if (!DRY && saved > 0) {
          try {
            fs.mkdirSync(TOK_DIR, { recursive: true })
            fs.writeFileSync(path.join(TOK_DIR, sid + '.json'), JSON.stringify({
              tokens: Math.max(0, tokens - saved),
              lastSeq: [...session.surface.nodes].pop() ?? 0,
              firstSeq: nodes[0]?.seq ?? 0,
              summarySeq,
              src: 'postPrune',
              at: Date.now(),
            }))
            log('折算现值写回：' + Math.max(0, tokens - saved) + ' token（等下一轮实测覆盖）')
          } catch {}
        }
        // 记一笔：哪份摘要、裁到哪个表面末 seq，防同一份摘要被重复裁
        try {
          const all = readStateFile(PRUNED_FILE)
          all[sid] = { summarySeq, tailSeq: [...session.surface.nodes].pop() ?? 0, at: Date.now() }
          fs.writeFileSync(PRUNED_FILE, JSON.stringify(all))
        } catch {}
      }
    } catch (e) {
      log('跳过（' + (e?.message ?? e) + '）');
    } finally {
      if (sidLock) { pruning.delete(sidLock); releaseLock(pruneLockName(sidLock)) }
    }
    return next();
  };
  // 不靠 globalThis 标记防重：插件被重载时旧实例的事件会随 ctx 一起销毁，
  // 但 globalThis 还在，会导致新实例永远不再注册 pre-step（token 不再更新）。
  // 改成每次都注册；重复执行由 pruning/tryLock 兜底。
  dlog('诊断注册：准备注册 pre-step');
  try {
    ctx.on('agent/pre-step', pruneStep);
    dlog('诊断注册：pre-step 已注册');
  } catch (e) {
    log('诊断注册：注册失败 ' + (e?.message ?? e));
  }
  // 摘要落地就裁（2026-11-14 管理员定）：派发任务进 inbox 后盯着表面，
  // 新摘要一出现立刻裁一次，不等下一轮对话；等不到就交回 pre-step / watcher 兜底。
  // （landingTimers / landingMsgs 已在 pruneStep 之前声明）
  ctx.effect(() => {
    return () => { for (const t of landingTimers.values()) clearInterval(t); landingTimers.clear() };
  });
  const LANDING_MAX_MS = Number(process.env.DSH_LOG_PRUNE_LANDING_WAIT ?? 10 * 60e3);
  const watchLanding = (agent) => {
    const sid = agent?.session?.id;
    if (!sid || landingTimers.has(sid)) return;
    // 基线取派发这一刻的表面末 seq：新摘要一定插在它后面（不依赖 watcher 的 state 写入时序）
    const base = [...(agent?.session?.surface?.nodes ?? [])].pop() ?? 0;
    if (!base) return;
    const started = Date.now();
    let settle = null;
    const stop = () => {
      const t = landingTimers.get(sid);
      if (t) { clearInterval(t); landingTimers.delete(sid) }
      if (settle) { clearTimeout(settle); settle = null }
    };
    // 落地后不立刻写 surface：等这一轮收尾（idle）再裁，最多等 30 秒，别跟运行时抢着写
    const pruneWhenSettled = (s) => {
      let tries = 0;
      const tick = () => {
        settle = null;
        if (agent?.status === 'idle' || ++tries > 15) {
          log('摘要落地 seq=' + s + '，裁切');
          void pruneStep({ agent }, async () => {});
          return;
        }
        settle = setTimeout(tick, 2000);
      };
      settle = setTimeout(tick, 2000);
    };
    const timer = setInterval(() => {
      try {
        const session = agent?.session;
        if (!session) { stop(); return }
        // 模型自己判断上下文已经变小、没写摘要：只重置冷却，不删记录（删了 watcher 会立刻重派）
        const ignored = scanIgnoredReply(session, base);
        if (ignored) {
          stop();
          landingMsgs.delete(sid);
          try {
            const all = readStateFile(REQ_FILE);
            if (all[sid]) { all[sid].at = Date.now(); fs.writeFileSync(REQ_FILE, JSON.stringify(all)) }
          } catch {}
          log('摘要任务被忽略（上下文已低于阈值，seq=' + ignored + '），进入冷却');
          return;
        }
        const s = scanSummarySeq(session, base);
        if (s > base) { stop(); pruneWhenSettled(s); return }
        const st = (() => { try { return JSON.parse(fs.readFileSync(path.join(TOK_DIR, sid + '.json'), 'utf8')) } catch { return null } })();
        const cfg = effectiveConfig(sid);
        const below = Math.round((cfg.summaryPoint || 0) * (cfg.summaryIgnoreRatio ?? 0.4));
        const stuck = Date.now() - started > LANDING_MAX_MS;
        if ((st && typeof st.tokens === 'number' && st.tokens < below) || stuck) {
          let removed = false;
          try {
            const mid = landingMsgs.get(sid);
            if (mid && typeof agent?.inbox?.remove === 'function') removed = agent.inbox.remove(mid) === true;
          } catch {}
          try {
            const all = readStateFile(REQ_FILE);
            if (all[sid]) { delete all[sid]; fs.writeFileSync(REQ_FILE, JSON.stringify(all)) }
          } catch {}
          landingMsgs.delete(sid);
          stop();
          log((stuck ? '摘要挂太久（' + Math.round((Date.now() - started) / 1000) + 's）' : '阈值已回落（tokens=' + st.tokens + '）') +
            '，摘要在队列里' + (removed ? '已撤掉' : '已取走、撤不掉'));
        }
      } catch { stop() }
    }, 2000);
    landingTimers.set(sid, timer);
  };
  if (!FLAGS.landing) {
    FLAGS.landing = true;
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    try {
      const text = JSON.stringify(message?.content ?? message ?? '');
      if (!/【裁切摘要任务】/.test(text)) return;
      if (message?.id && agent?.session?.id) landingMsgs.set(agent.session.id, message.id);
      watchLanding(agent);
    } catch {}
  });
  // 任务被丢掉了（手动取消/队列清理）：清掉派发记录，别让 watcher 一直等这份
  ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    try {
      const sid = agent?.session?.id;
      if (!sid) return;
      const text = JSON.stringify(message?.content ?? message ?? '');
      if (!/【裁切摘要任务】/.test(text)) return;
      try {
        const all = readStateFile(REQ_FILE);
        if (all[sid]) { delete all[sid]; fs.writeFileSync(REQ_FILE, JSON.stringify(all)) }
      } catch {}
      landingMsgs.delete(sid);
      const t = landingTimers.get(sid);
      if (t) { clearInterval(t); landingTimers.delete(sid) }
    } catch {}
  });
  }
}
