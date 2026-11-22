#!/usr/bin/env node
// 自检：判断 dsh-log-prune 在这台机器上为什么没加载
// 用法：node bin/doctor.mjs [profile 目录，默认 $DSH_HOME/profiles/web]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { resolveHome } from '../lib/home.mjs'
import { hostCompatible } from '../lib/semver.mjs'
const HOME = resolveHome()
// 默认 profile：扫所有 profile，挑真正声明了 dsh-log-prune 的那个；
// 命令行显式传了就用传的。比「先试 desktop 再试 web」更通用——
// 桌面端挂 desktop、web 端挂 web、自定义 profile 名也能找到（2026-11-16 修）
function pickDefaultProfile() {
  const profilesRoot = join(HOME, 'profiles')
  let names = []
  try { names = readdirSync(profilesRoot) } catch { return join(profilesRoot, 'web') }
  for (const name of names) {
    const dir = join(profilesRoot, name)
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (pkg && pkg.dependencies && pkg.dependencies['dsh-log-prune']) return dir
      const bundles = pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles
      if (Array.isArray(bundles) && bundles.includes('dsh-log-prune')) return dir
    } catch {}
    try {
      const txt = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
      if (txt.indexOf('dsh-log-prune') >= 0) return dir
    } catch {}
  }
  return join(profilesRoot, 'web')
}
const profile = resolve(process.argv[2] || pickDefaultProfile())
const out = []
const say = (m) => { out.push(m); console.log(m) }

say('DSH_HOME = ' + HOME)
say('profile   = ' + profile)
say('node      = ' + process.version)

// 1) 包在 profile 里能不能解析
let resolved = ''
try {
  const req = createRequire(join(profile, 'package.json'))
  resolved = req.resolve('dsh-log-prune')
  say('✓ 解析到插件入口：' + resolved)
} catch (e) {
  try {
    resolved = req.resolve('dsh-log-prune/package.json')
    say('✓ 只解析到 package.json：' + resolved)
  } catch (e2) {
    say('✗ profile 里解析不到 dsh-log-prune：' + e.message)
    say('  → 说明 profile 没装上/没链接到它，先解决这一步')
    process.exit(2)
  }
}

// 2) 宿主版本
try {
  const req = createRequire(join(profile, 'package.json'))
  let p
  try {
    p = JSON.parse(readFileSync(req.resolve('@deepseek-ai/dsh/package.json'), 'utf8'))
  } catch {
    // 2026-11-19：profile 没链接宿主包时（dsh 全局装在 node 的 lib/node_modules），按 node 可执行文件位置回退
    const globalPkg = join(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    p = JSON.parse(readFileSync(globalPkg, 'utf8'))
  }
  say('✓ @deepseek-ai/dsh ' + p.version)
  if (hostCompatible(p.version)) say('✓ 宿主版本在 peer 区间（>=0.2.1-rc.2 <0.3.0）')
  else say('⚠ 宿主版本 ' + p.version + ' 不在 peer 区间（>=0.2.1-rc.2 <0.3.0），可能不兼容')
} catch (e) { say('? 查不到宿主 dsh 版本（' + e.message + '）') }

// 3) 真正 import 一次（会跑插件模块顶层，但不会 apply）
const entry = resolved.endsWith('package.json') ? join(resolved, '..', 'lib/index.js') : resolved
try {
  const url = pathToFileURL(entry).href
  await import(url)
  say('✓ 入口 import 通过：' + entry)
} catch (e) {
  say('✗ 入口 import 失败：' + (e && (e.stack || e.message)))
  say('   ↑ 这一条就是桌面版「静默不激活」的根因')
  process.exit(3)
}

// 4) apply 试挂（用最小桩，验证 webServer 两个路由能注册）
try {
  const m = await import(pathToFileURL(entry).href)
  const regs = []
  const events = {}
  const ctx = {
    on: (n, f) => { events[n] = f },
    effect: (fn) => { try { fn() } catch (e) { say('  effect 报错：' + e.message) } },
    logger: { info: () => {} },
    webServer: { register: (r) => { regs.push(r.path); return () => {} } },
    // P1：apply 里会调 ctx.get('agents') 和 ctx.tools.register，桩缺这两个会让自检必挂
    // C2（2026-11-19）：toolbox 是裁切硬前置、apply 内 fail-fast；doctor 给空桩才能验证完整路径
    get: (k) => (k === 'toolbox' ? { name: 'toolbox' } : null),
    tools: { register: () => {} },
  }
  m.apply(ctx)
  say('✓ apply 通过，注册路由：' + regs.join(', '))
  say('✓ 注入钩子：' + (typeof events['webserver/index-inject'] === 'function' ? '有' : '没有'))
} catch (e) {
  say('✗ apply 失败：' + (e && (e.stack || e.message)))
  process.exit(4)
}

// 4.5) 宿主契约清单（静态，2026-11-19 B3/D6）
say('')
say('—— 宿主契约（静态）——')
const pluginDir = resolve(entry, '..', '..')
const readSrc = (f) => { try { return readFileSync(join(pluginDir, f), 'utf8') } catch { return '' } }
const idxSrc = readSrc('lib/index.js')
const foundEvents = [...new Set((idxSrc.match(/\.on\('([^']+)'/g) || []).map((s) => s.slice(4)))]
const foundServices = [...new Set((idxSrc.match(/ctx\.get\('([^']+)'\)/g) || []).map((s) => s.slice(8, -2)))]
say('事件: ' + (foundEvents.slice(0, 12).join(', ') || '（未识别）'))
say('服务: ' + (foundServices.slice(0, 12).join(', ') || '（未识别）'))
say('session 文件: ' + (existsSync(join(pluginDir, 'lib/session-file.mjs')) ? '按形状匹配（sessionFileName）✓' : '硬编码 v4 ✗'))
say('tokenMeter: 软依赖（inject 未声明），缺失时降级 usage→字数')

// 5) 归档闸门依赖（O5，2026-11-18）：裁切前必须确认原文已另存；这里检查三个外部契约
say('')
say('—— 归档闸门依赖 ——')
const wmFile = process.env.DSH_ARCHIVE_WM || join(HOME, 'state', 'archive-watermark.json')
// 2026-11-19 Windows：脚本按 DSH_HOME/bin → 插件自带 bin 的顺序找（tgz 已带 bin/archive-sessions.mjs）
const archScript = (() => {
  const cands = [
    process.env.DSH_ARCHIVE_SCRIPT,
    join(HOME, 'bin', 'archive-sessions.mjs'),
    join(dirname(fileURLToPath(import.meta.url)), 'archive-sessions.mjs'),
  ].filter(Boolean)
  return cands.find((p) => existsSync(p)) || cands[1]
})()
const archDir = join(HOME, '记忆', '日志存档')
try {
  const wm = JSON.parse(readFileSync(wmFile, 'utf8'))
  say('✓ 归档水位可读：' + wmFile + '（' + Object.keys(wm || {}).length + ' 个会话）')
} catch (e) {
  say('✗ 归档水位不可读：' + wmFile + '（' + (e?.message || e) + '）→ 裁切会一直判「归档未就绪」')
}
if (existsSync(archScript)) say('✓ 补归档脚本：' + archScript)
else say('✗ 补归档脚本不存在：' + archScript + ' → 闸门失败时 spawn 会失败，裁切停摆')
if (existsSync(archDir)) say('✓ 归档目录：' + archDir + '（' + readdirSync(archDir).length + ' 个文件）')
else say('✗ 归档目录不存在：' + archDir)

say('')
say('结论：插件包本身没问题；如果 DSH 里仍然不出现按钮，看宿主启动日志里有没有 "did not activate" 一行，把那一行发回来。')
process.exit(0)
