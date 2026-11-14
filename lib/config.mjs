// log-prune 配置：~/.dsh/state/log-prune.yml（热更新：改文件下一轮自动重读）
// 卡片接口：GET/POST /dsh-log-prune/config
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

import { resolveHome } from './home.mjs'
const HOME = resolveHome()
export const CONFIG_PATH = process.env.DSH_LOG_PRUNE_CONFIG || HOME + '/state/log-prune.yml'
export const SESSIONS_PATH = process.env.DSH_LOG_PRUNE_SESSIONS || HOME + '/state/log-prune-sessions.json'

const 宿主 = createRequire('/usr/lib/node_modules/@deepseek-ai/dsh/package.json')
let yaml = null
try { yaml = 宿主('js-yaml') } catch { try { yaml = 宿主('yaml') } catch { yaml = null } }

export const DEFAULTS = {
  keepTurns: 3,          // 裁切后至少保留的最近轮数（防把刚说的话裁掉）；推荐 2~5
  compactPoint: 650000,  // 预设的官方压缩阈值（等于窗口 × thresholdRatio）；换预设要同步；推荐 60~70 万
  triggerRatio: 550000 / 650000, // 强制裁切线 = compactPoint × 本比例；推荐 0.80~0.90
  keepTokens: 100000,    // 无摘要时裁切后保留的 token；推荐 8~15 万
  summaryTrigger: 400000,// 有摘要后，到多少 token 就裁掉摘要之前的内容；推荐 35~45 万
  longtextLimit: 8192,   // 单条 user 消息超过多少字落盘；推荐 6000~12000
  summaryEnabled: true,  // 是否让插件自己排摘要任务
  summaryPoint: 400000,  // 摘要触发线（与 summaryTrigger 联动，通常同值）；推荐 35~45 万
  summaryIntervalMs: 20000, // 轮询间隔；推荐 10~60 秒
  summaryCooldownMs: 600000, // 同一会话两次摘要请求的最小间隔；推荐 5~15 分钟
  summaryApiUrl: '',     // 本机 API 地址（留空 = 用环境变量 DSH_DISPATCH_API 或本机默认端口）
  summaryClientPath: '', // 排队摘要用的客户端模块路径（留空 = 用环境变量 DSH_SUMMARY_CLIENT）
  handoffEnabled: false, // 裁切后是否把这段内容交接给其它插件（默认关）
  handoffEvent: true,    // 交接方式：发事件 log-prune/pruned
  handoffDir: '',        // 交接清单输出目录（留空 = <DSH_HOME>/state/pruned-outbox）
  archiveDir: '',        // 归档目录（留空 = <DSH_HOME>/记忆/日志存档）
  mirrorDir: '',         // 实时镜像目录（留空 = <DSH_HOME>/记忆/镜像）
}

function 读yaml(文本) {
  if (!yaml) return {}
  try { return (yaml.load ? yaml.load(文本) : yaml.parse(文本)) || {} } catch { return {} }
}

export function 默认文本(v = DEFAULTS) {
  return [
    '# log-prune 配置（热更新：保存后下一轮自动生效，不用重启）',
    '# 说明：这些数值互相联动，改之前先看每行的「联动/推荐」注释',
    '',
    '## —— 裁切 ——',
    '# 裁切后至少保留最近几轮对话。太小会把刚说的话裁掉，太大会省得少',
    'keepTurns: ' + v.keepTurns + '           # 推荐 2~5',
    '',
    '# 预设的官方压缩阈值（窗口 × thresholdRatio）。换预设、改预设阈值时必须同步这里',
    'compactPoint: ' + v.compactPoint + '   # 推荐 60~70 万（等于 100 万窗口 × 0.65）',
    '',
    '# 强制裁切线 = compactPoint × triggerRatio。给官方压缩留兜底余量，别贴太近',
    'triggerRatio: ' + Number(v.triggerRatio).toFixed(4) + '   # 推荐 0.80~0.90（当前 55/65 ≈ 0.846）',
    '',
    '# 没有摘要时，裁切后保留多少 token；和 compactPoint 联动，约为窗口 10%',
    'keepTokens: ' + v.keepTokens + '     # 推荐 8~15 万',
    '',
    '# 有摘要之后，到多少 token 就把摘要之前的内容整段裁掉，只留摘要 + 门牌 + 最近几轮',
    'summaryTrigger: ' + v.summaryTrigger + '  # 推荐 35~45 万（比 summaryPoint 略高或同值）',
    '',
    '# 单条 user 消息超过多少字就写盘，界面上只留一行【长文落盘】指针',
    'longtextLimit: ' + v.longtextLimit + '    # 推荐 6000~12000',
    '',
    '## —— 摘要任务 ——',
    '# 插件是否自己给会话排摘要任务（关掉后只能手动排）',
    'summaryEnabled: ' + Boolean(v.summaryEnabled),
    '',
    '# 摘要触发线：token 到这个数就排一次摘要任务；与 summaryTrigger 联动，通常同值',
    'summaryPoint: ' + v.summaryPoint + '   # 推荐 35~45 万',
    '',
    '# 轮询间隔：多久扫一次各会话的 token 状态',
    'summaryIntervalMs: ' + v.summaryIntervalMs + '  # 推荐 10000~60000',
    '',
    '# 同一会话两次摘要的最小间隔，防止反复唤醒',
    'summaryCooldownMs: ' + v.summaryCooldownMs + '  # 推荐 300000~900000',
    '',
    '# 下面几项留空 = 用环境变量或内置默认值；换机器/换插件时只改这里',
    '# ── 摘要派发（可选）：不填也能裁切，但不会自动排摘要任务 ──',
    '# 摘要要用一个能 import 的客户端模块去调本机 API；在 DSH 安装目录里搜 "class NodeApiClient"，',
    '# 找到的那个 .js 文件的绝对路径填到下面，Windows 用正斜杠或双反斜杠',
    'summaryClientPath: ""    # 例：C:~/.dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/client.node.js',
    '# dsh web 的地址；不填用默认端口，填就写全，例 http://127.0.0.1:3080',
    'summaryApiUrl: ""        # 例：http://127.0.0.1:3080',
    'archiveDir: ""           # 归档目录；留空用 <DSH_HOME>/记忆/日志存档',
    'mirrorDir: ""            # 实时镜像目录；留空用 <DSH_HOME>/记忆/镜像',
    '',
    '## —— 交接（给别的插件/agent 用）——',
    '# 裁切后是否把这段内容写清单 + 发事件，方便记忆/日记插件接走；默认关',
    'handoffEnabled: ' + Boolean(v.handoffEnabled),
    '',
    '# 是否发事件 log-prune/pruned（同进程的插件可以 ctx.on 订阅）',
    'handoffEvent: ' + Boolean(v.handoffEvent),
    '',
    '# 清单输出目录；留空用 <DSH_HOME>/state/pruned-outbox',
    'handoffDir: ""',
    '',
  ].join(String.fromCharCode(10))
}

let 缓存 = { at: 0, mtime: 0, cfg: null }
export function loadConfig() {
  try {
    const st = fs.statSync(CONFIG_PATH)
    if (缓存.cfg && st.mtimeMs === 缓存.mtime) return 缓存.cfg
    const 文本 = fs.readFileSync(CONFIG_PATH, 'utf8')
    const 用户 = 读yaml(文本)
    const cfg = {}
    for (const k of Object.keys(DEFAULTS)) cfg[k] = 用户[k] === undefined ? DEFAULTS[k] : 用户[k]
    cfg.keepTurns = Math.max(0, Math.min(20, Number(cfg.keepTurns) || 0))
    cfg.compactPoint = Math.max(50000, Number(cfg.compactPoint) || DEFAULTS.compactPoint)
    cfg.triggerRatio = Math.max(0.3, Math.min(1, Number(cfg.triggerRatio) || DEFAULTS.triggerRatio))
    cfg.keepTokens = Math.max(10000, Number(cfg.keepTokens) || DEFAULTS.keepTokens)
    cfg.summaryTrigger = Math.max(50000, Number(cfg.summaryTrigger) || DEFAULTS.summaryTrigger)
    cfg.longtextLimit = Math.max(1000, Number(cfg.longtextLimit) || DEFAULTS.longtextLimit)
    cfg.summaryEnabled = cfg.summaryEnabled !== false && cfg.summaryEnabled !== 'false'
    cfg.summaryPoint = Math.max(50000, Number(cfg.summaryPoint) || DEFAULTS.summaryPoint)
    cfg.summaryIntervalMs = Math.max(3000, Number(cfg.summaryIntervalMs) || DEFAULTS.summaryIntervalMs)
    cfg.summaryCooldownMs = Math.max(30000, Number(cfg.summaryCooldownMs) || DEFAULTS.summaryCooldownMs)
    cfg.handoffEnabled = cfg.handoffEnabled === true || cfg.handoffEnabled === 'true'
    cfg.handoffEvent = cfg.handoffEvent !== false && cfg.handoffEvent !== 'false'
    cfg.summaryApiUrl = String(cfg.summaryApiUrl || '')
    cfg.summaryClientPath = String(cfg.summaryClientPath || '')
    cfg.handoffDir = String(cfg.handoffDir || '')
    cfg.archiveDir = String(cfg.archiveDir || '')
    cfg.mirrorDir = String(cfg.mirrorDir || '')
    缓存 = { at: Date.now(), mtime: st.mtimeMs, cfg }
    return cfg
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveConfig(部分) {
  const 当前 = loadConfig()
  const 新 = { ...当前, ...部分 }
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, 默认文本(新))
  缓存 = { at: 0, mtime: 0, cfg: null }
  return loadConfig()
}


// —— 会话级覆盖：只存与全局不同的字段；没有条目 = 跟随全局 ——
export function loadSessions() {
  try {
    const j = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'))
    return j && typeof j === 'object' ? j : {}
  } catch { return {} }
}

export function saveSessions(map) {
  fs.mkdirSync(path.dirname(SESSIONS_PATH), { recursive: true })
  fs.writeFileSync(SESSIONS_PATH, JSON.stringify(map, null, 2) + String.fromCharCode(10))
}

export function effectiveConfig(sid) {
  const g = loadConfig()
  if (!sid) return g
  const o = loadSessions()[String(sid)]
  return o && typeof o === 'object' ? { ...g, ...o } : g
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
  fs.writeFileSync(CONFIG_PATH, 默认文本(DEFAULTS))
  return true
}
