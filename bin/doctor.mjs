#!/usr/bin/env node
// 自检：判断 dsh-log-prune 在这台机器上为什么没加载
// 用法：node bin/doctor.mjs [profile 目录，默认 $DSH_HOME/profiles/web]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const HOME = process.env.DSH_HOME || join(process.env.HOME || '/root', '.dsh')
const profile = resolve(process.argv[2] || join(HOME, 'profiles/web'))
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
  const p = JSON.parse(readFileSync(req.resolve('@deepseek-ai/dsh/package.json'), 'utf8'))
  say('✓ @deepseek-ai/dsh ' + p.version)
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
  }
  m.apply(ctx)
  say('✓ apply 通过，注册路由：' + regs.join(', '))
  say('✓ 注入钩子：' + (typeof events['webserver/index-inject'] === 'function' ? '有' : '没有'))
} catch (e) {
  say('✗ apply 失败：' + (e && (e.stack || e.message)))
  process.exit(4)
}

say('')
say('结论：插件包本身没问题；如果 DSH 里仍然不出现按钮，看宿主启动日志里有没有 "did not activate" 一行，把那一行发回来。')
