// log-prune 配置：/data/dsh/state/log-prune.yml（热更新：改文件下个检查周期自动重读）
// 卡片接口：GET/POST /dsh-log-prune/config
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { resolveHome } from './home.mjs'
import { normalizeTimeZone, setTimeZone } from './tz.mjs'
import { writeFileAtomic } from './atomic.mjs'
import { candidateRoots } from './hostdeps.mjs'
const HOME = resolveHome()
// W3：统一 path.join，Windows 下不再出现 C:\\data\\dsh/state 这种混合分隔符
export const CONFIG_PATH = process.env.DSH_LOG_PRUNE_CONFIG || path.join(HOME, 'state', 'log-prune.yml')
export const SESSIONS_PATH = process.env.DSH_LOG_PRUNE_SESSIONS || path.join(HOME, 'state', 'log-prune-sessions.json')

// 宿主 require 候选：不写死 Linux 路径（Windows 上是 exe/resources/app.asar 那套）
// require 基准：跟 hostdeps 用同一份候选根（/usr/local、/usr/lib、桌面版 asar、profile 树、自己的 node_modules），
// 以前只写死 /usr/lib —— 装在 nvm/pnpm/别的前缀的机器上会 require 不到 js-yaml（2026-11-16 二次审查）
const 宿主 = (() => {
  const cands = []
  try { for (const root of candidateRoots()) cands.push(path.join(root, 'dsh', 'package.json'), path.join(root, 'noop.js')) } catch {}
  cands.push('/usr/lib/node_modules/@deepseek-ai/dsh/package.json')
  cands.push(process.env.DSH_HOME && path.join(process.env.DSH_HOME, 'node_modules', 'noop.js'))
  cands.push(path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'package.json'))
  cands.push(path.join(path.dirname(process.execPath), 'node_modules', 'noop.js'))
  for (const c of cands.filter(Boolean)) {
    try { return createRequire(c) } catch {}
  }
  try { return createRequire(import.meta.url) } catch {}
  return null
})()
let yaml = null
if (宿主) { try { yaml = 宿主('js-yaml') } catch { try { yaml = 宿主('yaml') } catch { yaml = null } } }

export const DEFAULTS = {
  keepTurns: 3,          // 裁切后至少保留的最近轮数（防把刚说的话裁掉）；推荐 2~5
  compactPoint: 650000,  // 预设的官方压缩阈值（等于窗口 × thresholdRatio）；换预设要同步；推荐 60~70 万
  triggerRatio: 550000 / 650000, // 强制裁切线 = compactPoint × 本比例；推荐 0.80~0.90
  keepTokens: 100000,    // 无摘要时裁切后保留的 token；推荐 8~15 万
  summaryTrigger: 400000,// 兼容/面板联动字段；实际摘要派发看 summaryPoint；推荐 35~45 万
  longtextLimit: 8192,   // 单条 user 消息超过多少字落盘；推荐 6000~12000
  plateMerge: false,     // 新旧门牌合并（默认关；开了才把旧门牌并进新门牌，会放开门牌区间的严格递增检查）
  summaryEnabled: true,  // 是否让插件自己排摘要任务
  summaryPoint: 400000,  // 摘要触发线（与 summaryTrigger 联动，通常同值）；推荐 35~45 万
  summaryIntervalMs: 20000, // 轮询间隔；推荐 10~60 秒
  summaryCooldownMs: 600000, // 同一会话两次摘要请求的最小间隔；推荐 5~15 分钟
  summaryIgnoreRatio: 0.4, // 摘要任务里「上下文已低于阈值 X% 就忽略」的比例；默认 0.4（4 成）
  summaryApiUrl: '',     // 本机 API 地址（留空 = 用环境变量 DSH_DISPATCH_API 或本机默认端口）
  summaryClientPath: '', // 排队摘要用的客户端模块路径（留空 = 用环境变量 DSH_SUMMARY_CLIENT）
  handoffEnabled: false, // 裁切后是否把这段内容交接给其它插件（默认关）
  handoffEvent: true,    // 交接方式：发事件 log-prune/pruned
  handoffDir: '',        // 交接清单输出目录（留空 = <DSH_HOME>/state/pruned-outbox）
  archiveDir: '',        // 归档目录（留空 = <DSH_HOME>/记忆/日志存档）
  mirrorDir: '',         // 实时镜像目录（留空 = <DSH_HOME>/记忆/镜像）
  updateCheck: true,     // 是否允许插件自己查更新（默认开；关掉后不发任何外网请求）
  autoScan: false,       // 打开面板时是否自动扫描会话列表（默认关，打开面板不扫 sessions 树）
  autoClean: false,      // 每天到点自动派发离线清理（默认关，需在面板里主动打开）
  timezone: 'Asia/Shanghai', // 全插件时区（IANA 名称，如 Asia/Shanghai、America/New_York）；影响门牌日期、每日清理与归档切片
  cleanAtHour: 4,        // 自动清理执行时间·时（0-23，24 小时制，按 timezone 计）
  cleanAtMinute: 30,     // 自动清理执行时间·分（0-59）
  allowRemote: false,    // 是否允许非本机访问面板/接口（默认关；开了之后请求头要带 x-lp-token）
  trustProxy: false,     // 只有前面挂的代理会覆盖 X-Forwarded-For 时才开；默认忽略该头（可伪造）
  plainEnabled: true,    // 是否写「明文副本 <day>.txt」（检索便利层）；关掉只留轻索引 .idx
  plainMaxChars: 20000,  // 单条正文写盘前截断的字数；0 = 不截断（tool 结果是体积主因）
  plainKeepDays: 30,     // 明文 .txt 的保留天数，超过自动清理
  plainRedact: true,     // 写盘前对疑似密钥/token/密码脱敏（默认开）
  // O1 检索层永续化：.idx 每条仅约 200~300 字节，永久保留完全可承受；0 = 永久
  idxKeepDays: 0,
  // O2 时代摘要合并：门牌/旧摘要堆积到阈值就派一次「合并模式」摘要任务，常驻 token 从线性变常数
  eraMerge: false,       // 默认关，跑稳一个版本再转默认开
  eraMergePlates: 4,     // 门牌块数达到该值触发
  eraMergeSummaries: 2,  // 旧摘要条数达到该值触发
  // O3 后台预归档：接近摘要线的会话提前补档，首次裁切不再现场等 60 秒
  preArchive: true,
  preArchiveRatio: 0.6,  // 触发比例（× summaryPoint）
}

// Q7：这些阈值以前只有同名常量（只打印在日志里），环境变量等于没用。
// 现在环境变量作为「默认值层」：yaml 没写的键才采纳，yaml 写了以 yaml 为准。
const ENV_KEYS = {
  keepTurns: 'DSH_LOG_PRUNE_KEEP',
  compactPoint: 'DSH_LOG_PRUNE_COMPACT',
  triggerRatio: 'DSH_LOG_PRUNE_TRIGGER_RATIO',
  keepTokens: 'DSH_LOG_PRUNE_KEEP_TOKENS',
  summaryTrigger: 'DSH_LOG_PRUNE_SUMMARY_TRIGGER',
  longtextLimit: 'DSH_LOG_PRUNE_LONGTEXT',
}
export function envDefaults() {
  const out = { ...DEFAULTS }
  if (process.env.DSH_TZ) out.timezone = process.env.DSH_TZ
  for (const [k, env] of Object.entries(ENV_KEYS)) {
    const v = process.env[env]
    if (v !== undefined && v !== '' && Number.isFinite(Number(v))) out[k] = Number(v)
  }
  // 兼容旧环境变量：DSH_CLEAN_AT=HH:MM 作为时/分的默认值层（yaml 写了仍以 yaml 为准）
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(process.env.DSH_CLEAN_AT || '').trim())
  if (m) {
    const h = Number(m[1]), mi = Number(m[2])
    if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59) { out.cleanAtHour = h; out.cleanAtMinute = mi }
  }
  return out
}

// 平铺 YAML 兜底：本插件的配置是扁平的 key: value，没有 yaml 库也要能读。
// 以前拿不到 js-yaml 就直接返回 {}，用户的配置被静默忽略、全部走默认值（2026-11-16 二次审查）
// V4：只在「# 前有空白、且不在引号内」时截注释；值里的 #（路径片段/URL fragment）不能丢
function 去注释(s) {
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === quote) {
        if (quote === "'" && s[i + 1] === "'") { i++; continue }
        quote = ''
      }
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i)
  }
  return s
}
export function 读平铺Yaml(文本) {
  const out = {}
  for (const raw of String(文本 || '').split(/\r?\n/)) {
    let line = 去注释(raw).trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2].trim()
    if (v === '') { out[m[1]] = ''; continue }
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1)
    else if (v === 'true') v = true
    else if (v === 'false') v = false
    else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v)
    out[m[1]] = v
  }
  return out
}

function 读yaml(文本) {
  if (!yaml) return 读平铺Yaml(文本)
  try { return (yaml.load ? yaml.load(文本) : yaml.parse(文本)) || {} } catch { return 读平铺Yaml(文本) }
}
// S7：默认配置模板外置到 templates/log-prune.yml.tpl（随包发布），代码只做值替换
let _tplCache = null
function 模板文本() {
  if (_tplCache !== null) return _tplCache
  _tplCache = fs.readFileSync(fileURLToPath(new URL('../templates/log-prune.yml.tpl', import.meta.url)), 'utf8')
  return _tplCache
}
// 模板里写成 `key: @@key@@`，保留右侧的对齐空格与注释；特殊小数位格式在这里补
const 配置值格式 = {
  triggerRatio: (v) => Number(v).toFixed(4),
  preArchiveRatio: (v) => Number(v).toFixed(2),
}
export function 默认文本(v = DEFAULTS) {
  return 模板文本().replace(/^([A-Za-z0-9_.-]+): @@\1@@/gm, (m, k) => {
    const f = 配置值格式[k]
    return k + ': ' + (f ? f(v[k]) : 格式化配置值(v[k]))
  })
}

// C2：约束抽出来，正常分支和「配置文件不存在/读失败」分支都要过一遍，
// 否则 DSH_LOG_PRUNE_* 环境变量能绕过上下界（例如 keepTokens=-5 会让裁切一直裁到 keepTurns 限）
function clampCfg(cfg, BASE) {
  cfg.keepTurns = Math.max(0, Math.min(20, Number(cfg.keepTurns) || 0))
  cfg.compactPoint = Math.max(50000, Number(cfg.compactPoint) || BASE.compactPoint)
  cfg.triggerRatio = Math.max(0.3, Math.min(1, Number(cfg.triggerRatio) || BASE.triggerRatio))
  cfg.keepTokens = Math.max(10000, Number(cfg.keepTokens) || BASE.keepTokens)
  cfg.summaryTrigger = Math.max(50000, Number(cfg.summaryTrigger) || BASE.summaryTrigger)
  cfg.longtextLimit = Math.max(1000, Number(cfg.longtextLimit) || BASE.longtextLimit)
  cfg.summaryEnabled = cfg.summaryEnabled !== false && cfg.summaryEnabled !== 'false'
  cfg.summaryPoint = Math.max(50000, Number(cfg.summaryPoint) || BASE.summaryPoint)
  cfg.summaryIntervalMs = Math.max(3000, Number(cfg.summaryIntervalMs) || BASE.summaryIntervalMs)
  cfg.summaryCooldownMs = Math.max(30000, Number(cfg.summaryCooldownMs) || BASE.summaryCooldownMs)
  cfg.summaryIgnoreRatio = Math.min(0.9, Math.max(0.1, Number(cfg.summaryIgnoreRatio) || BASE.summaryIgnoreRatio))
  cfg.allowRemote = cfg.allowRemote === true || cfg.allowRemote === 'true'
  cfg.plainEnabled = cfg.plainEnabled !== false && cfg.plainEnabled !== 'false'
  cfg.plainRedact = cfg.plainRedact !== false && cfg.plainRedact !== 'false'
  // 注意 0 是合法值（不截断），别被 || 吞成默认
  const _pmc = Number(cfg.plainMaxChars)
  cfg.plainMaxChars = _pmc === 0 ? 0 : Math.max(1000, Math.min(400000, Number.isFinite(_pmc) && _pmc > 0 ? _pmc : BASE.plainMaxChars))
  cfg.plainKeepDays = Math.max(1, Math.min(3650, Number(cfg.plainKeepDays) || BASE.plainKeepDays))
  // O1：idxKeepDays 的 0 是合法值（永久保留），别被 || 吞成默认
  const _ikd = Number(cfg.idxKeepDays)
  cfg.idxKeepDays = Number.isFinite(_ikd) && _ikd > 0 ? Math.min(3650, Math.floor(_ikd)) : 0
  // O2：阈值下限收紧，防止误配成「每次都合并」
  cfg.eraMerge = cfg.eraMerge === true || cfg.eraMerge === 'true'
  cfg.eraMergePlates = Math.max(2, Math.min(64, Number(cfg.eraMergePlates) || BASE.eraMergePlates))
  cfg.eraMergeSummaries = Math.max(2, Math.min(32, Number(cfg.eraMergeSummaries) || BASE.eraMergeSummaries))
  // O3
  cfg.preArchive = cfg.preArchive !== false && cfg.preArchive !== 'false'
  const _par = Number(cfg.preArchiveRatio)
  cfg.preArchiveRatio = Math.min(0.95, Math.max(0.2, Number.isFinite(_par) && _par > 0 ? _par : BASE.preArchiveRatio))
  cfg.autoScan = cfg.autoScan === true || cfg.autoScan === 'true'
  // 自动清理：开关 + 执行时间（空值/非法值回默认，时 0-23、分 0-59）
  cfg.timezone = normalizeTimeZone(cfg.timezone)
  cfg.autoClean = cfg.autoClean === true || cfg.autoClean === 'true'
  const _ch = cfg.cleanAtHour === '' || cfg.cleanAtHour == null ? NaN : Number(cfg.cleanAtHour)
  cfg.cleanAtHour = Number.isFinite(_ch) ? Math.min(23, Math.max(0, Math.floor(_ch))) : BASE.cleanAtHour
  const _cm = cfg.cleanAtMinute === '' || cfg.cleanAtMinute == null ? NaN : Number(cfg.cleanAtMinute)
  cfg.cleanAtMinute = Number.isFinite(_cm) ? Math.min(59, Math.max(0, Math.floor(_cm))) : BASE.cleanAtMinute
  cfg.handoffEnabled = cfg.handoffEnabled === true || cfg.handoffEnabled === 'true'
  cfg.handoffEvent = cfg.handoffEvent !== false && cfg.handoffEvent !== 'false'
  cfg.summaryApiUrl = String(cfg.summaryApiUrl || '')
  cfg.summaryClientPath = String(cfg.summaryClientPath || '')
  cfg.handoffDir = String(cfg.handoffDir || '')
  cfg.archiveDir = String(cfg.archiveDir || '')
  cfg.mirrorDir = String(cfg.mirrorDir || '')
  return cfg
}

// P10：配置文件缺失时也做 10 秒负缓存，watcher 每 tick 不用反复 stat+read 失败
let 缓存 = { at: 0, mtime: 0, cfg: null, missAt: 0 }
// P8：环境变量进程内不变，模块加载时算一次；原来每次 loadConfig 都重建 BASE，缓存命中时白算
const ENV_BASE = envDefaults()
function loadConfigRaw() {
  const BASE = ENV_BASE // Q7：环境变量覆盖默认值（yaml 未写的键）
  if (缓存.missAt && Date.now() - 缓存.missAt < 10000) return clampCfg({ ...ENV_BASE }, ENV_BASE)
  try {
    const st = fs.statSync(CONFIG_PATH)
    if (缓存.cfg && st.mtimeMs === 缓存.mtime) return 缓存.cfg
    const 文本 = fs.readFileSync(CONFIG_PATH, 'utf8')
    const 用户 = 读yaml(文本)
    const cfg = {}
    for (const k of Object.keys(BASE)) cfg[k] = 用户[k] === undefined ? BASE[k] : 用户[k]
    // 兼容旧配置：只写了 summaryTrigger、没写 summaryPoint 时，前者作为后者的回退。
    // 两个都写时以 summaryPoint 为准（面板会负责把它们保持同值）。
    if (用户.summaryPoint === undefined && 用户.summaryTrigger !== undefined) cfg.summaryPoint = 用户.summaryTrigger
    clampCfg(cfg, BASE)
    缓存 = { at: Date.now(), mtime: st.mtimeMs, cfg, missAt: 0 }
    return cfg
  } catch {
    缓存 = { at: 0, mtime: 0, cfg: null, missAt: Date.now() }
    return clampCfg({ ...ENV_BASE }, ENV_BASE)
  }
}

function 格式化配置值(v) {
  if (typeof v === 'boolean') return String(v)
  if (typeof v === 'number') return String(v)
  return JSON.stringify(String(v ?? ''))
}
// O8：按行原位替换值，保留用户手写的注释、空行和未知键；新键才从默认模板补
export function 保留注释更新(原文, 新) {
  const seen = new Set()
  const out = []
  for (const line of String(原文 || '').split(/\r?\n/)) {
    const m = line.match(/^([ \t]*)([A-Za-z0-9_.-]+)([ \t]*:[ \t]*)(.*)$/)
    if (!m || !(m[2] in DEFAULTS)) { out.push(line); continue }
    const key = m[2]
    seen.add(key)
    // 注释前的空白必须至少保留一个：去掉后写成 `""# 例：...`，
    // YAML 会把 # 当成引号标量的一部分，下一轮读成 `""# 例：...` 整串值；
    // 面板再保存时 JSON.stringify 会不断加反斜杠（2026-11-21 实测配置被写坏）。
    const before = 去注释(m[4])
    const hasComment = before.length < m[4].length
    const comment = hasComment ? m[4].slice(before.length) : ''
    const sep = hasComment ? ((/[ \t]+$/.exec(before) || [' '])[0]) : ''
    out.push(m[1] + key + m[3] + 格式化配置值(新[key]) + sep + comment)
  }
  for (const line of 默认文本(新).split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:/)
    if (!m || seen.has(m[1]) || !(m[1] in DEFAULTS)) continue
    out.push(line)
    seen.add(m[1])
  }
  return out.join('\n') + '\n'
}
export function saveConfig(部分) {
  const 当前 = loadConfig()
  const 新 = { ...当前, ...部分 }
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  // Q17：写之前先备份；用户手写的、插件不认识的键原样保留在文件末尾
  let 未知 = {}
  let 原文 = ''
  try {
    原文 = fs.readFileSync(CONFIG_PATH, 'utf8')
    // P7：备份最多留 5 个，长期积累会有成百上千个 .bak- 文件
    try {
      const dir = path.dirname(CONFIG_PATH)
      const base = path.basename(CONFIG_PATH)
      const baks = fs.readdirSync(dir)
        .filter((f) => f.startsWith(base + '.bak-'))
        .map((f) => ({ f, at: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.at - a.at)
      for (const b of baks.slice(5)) { try { fs.unlinkSync(path.join(dir, b.f)) } catch {} }
    } catch {}
    fs.writeFileSync(CONFIG_PATH + '.bak-' + new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14), 原文)
    const 已有 = 读yaml(原文)
    for (const k of Object.keys(已有)) if (!(k in DEFAULTS)) 未知[k] = 已有[k]
  } catch {}
  let 文本 = 原文 ? 保留注释更新(原文, 新) : 默认文本(新)
  const 额外 = Object.keys(未知)
  if (!原文 && 额外.length) {
    文本 += String.fromCharCode(10) + '# —— 插件不认识的键（原样保留，避免手写配置丢失）——' + String.fromCharCode(10)
    for (const k of 额外) 文本 += k + ': ' + JSON.stringify(未知[k]) + String.fromCharCode(10)
  }
  writeFileAtomic(CONFIG_PATH, 文本)
  缓存 = { at: 0, mtime: 0, cfg: null, missAt: 0 }
  return loadConfig()
}


// —— 会话级覆盖：只存与全局不同的字段；没有条目 = 跟随全局 ——
// P17：effectiveConfig 在 watcher 里每个会话每 tick 都调一次，每次 readFileSync 整份文件太浪费
let 会话缓存 = { mtime: 0, map: {} }
export function loadSessions() {
  try {
    const st = fs.statSync(SESSIONS_PATH)
    if (会话缓存.mtime === st.mtimeMs) return 会话缓存.map
    const j = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'))
    const map = j && typeof j === 'object' ? j : {}
    会话缓存 = { mtime: st.mtimeMs, map }
    return map
  } catch { return {} }
}

export function saveSessions(map) {
  fs.mkdirSync(path.dirname(SESSIONS_PATH), { recursive: true })
  fs.writeFileSync(SESSIONS_PATH, JSON.stringify(map, null, 2) + String.fromCharCode(10))
  会话缓存 = { mtime: 0, map: {} } // P17：写完让缓存失效
}

// 这些键只认全局配置（面板「其他设置」整组）：会话覆盖里即使有旧值也忽略，避免改了全局却被旧覆盖盖住
export const GLOBAL_KEYS = ['updateCheck', 'autoScan', 'autoClean', 'cleanAtHour', 'cleanAtMinute', 'timezone', 'handoffEnabled', 'handoffEvent']

// 每次读配置都同步一次时区：面板保存/热更新后，下一轮立刻用新时区
export function loadConfig() {
  const cfg = loadConfigRaw()
  setTimeZone(cfg.timezone)
  return cfg
}

export function effectiveConfig(sid) {
  const g = loadConfig()
  if (!sid) return g
  const o = loadSessions()[String(sid)]
  if (!o || typeof o !== 'object') return g
  const merged = { ...g }
  for (const k of Object.keys(o)) if (GLOBAL_KEYS.indexOf(k) < 0) merged[k] = o[k]
  return merged
}

export function setSessionOverride(sid, partial) {
  if (!sid) throw new Error('缺 sid')
  const map = loadSessions()
  const g = loadConfig()
  const diff = {}
  for (const k of Object.keys(DEFAULTS)) {
    if (partial[k] === undefined) continue
    const v = partial[k]
    if (String(v) !== String(g[k])) diff[k] = v
  }
  if (Object.keys(diff).length === 0) delete map[String(sid)]
  else map[String(sid)] = diff
  saveSessions(map)
  return map[String(sid)] ?? null
}

export function clearSessionOverride(sid) {
  const map = loadSessions()
  if (!sid || !(String(sid) in map)) return false
  delete map[String(sid)]
  saveSessions(map)
  return true
}

export function ensureConfigFile() {
  try { fs.accessSync(CONFIG_PATH); return false } catch {}
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  // P9：首次生成时把环境变量的值也写进去，否则面板显示的默认值和实际生效值不一致
  fs.writeFileSync(CONFIG_PATH, 默认文本(envDefaults()))
  缓存 = { at: 0, mtime: 0, cfg: null, missAt: 0 }
  return true
}
