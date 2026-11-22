// P4 冒烟测试：往 prune-status.json 塞一条假孤儿，验证面板能显示、修复能清。
// 不碰任何会话文件。
//   node test/p4-smoke.mjs            塞假孤儿（默认取最近有 token 记录的会话）
//   node test/p4-smoke.mjs <sid>      指定会话
//   node test/p4-smoke.mjs --restore  从备份恢复状态文件
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATUS = path.join(HOME, 'state', 'prune-status.json')
const TOK = path.join(HOME, 'state', 'prune-tokens')

function 最近会话() {
  try {
    const files = fs.readdirSync(TOK).filter((f) => f.endsWith('.json'))
      .map((f) => ({ id: f.slice(0, -5), at: fs.statSync(path.join(TOK, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
    if (files.length) return files[0].id
  } catch {}
  return ''
}

const args = process.argv.slice(2)

// N-a：--clean 只删测试备份，不动状态文件
if (args.includes('--clean')) {
  let 备份 = []
  try {
    备份 = fs.readdirSync(path.dirname(STATUS))
      .filter((f) => f.startsWith('prune-status.json.p4test-'))
  } catch {}
  for (const f of 备份) { try { fs.unlinkSync(path.join(path.dirname(STATUS), f)) } catch {} }
  console.log('已清掉 ' + 备份.length + ' 个测试备份')
  process.exit(0)
}

// N-a：--restore 恢复最早那份（干净基线），不再顺带删备份
if (args.includes('--restore')) {
  let 备份 = []
  try {
    备份 = fs.readdirSync(path.dirname(STATUS))
      .filter((f) => f.startsWith('prune-status.json.p4test-'))
      .sort()
  } catch {}
  if (!备份.length) { console.log('没有找到备份，什么也不做'); process.exit(0) }
  const 最早 = path.join(path.dirname(STATUS), 备份[0])
  fs.copyFileSync(最早, STATUS)
  console.log('已从 ' + 最早 + ' 恢复（最早备份 = 干净基线）')
  console.log('如需清掉测试备份：node test/p4-smoke.mjs --clean')
  process.exit(0)
}

const SID = args.find((a) => !a.startsWith('--')) || 最近会话()
if (!SID) { console.error('没找到会话 id，用法：node test/p4-smoke.mjs <sid>'); process.exit(2) }

// N-a：已有备份就跳过，保住最早那份干净基线
let 原 = {}
try { 原 = JSON.parse(fs.readFileSync(STATUS, 'utf8')) } catch {}
let 已有备份 = []
try {
  已有备份 = fs.readdirSync(path.dirname(STATUS))
    .filter((f) => f.startsWith('prune-status.json.p4test-'))
} catch {}
if (!已有备份.length) {
  const 备份 = STATUS + '.p4test-' + Date.now()
  try {
    fs.mkdirSync(path.dirname(STATUS), { recursive: true })   // 目录不在就先建
    if (Object.keys(原).length) fs.copyFileSync(STATUS, 备份)
    else fs.writeFileSync(备份, '{}')                         // 原文件不存在：空的也能当基线
    console.log('已备份状态文件到 ' + 备份)
  } catch {}
} else {
  console.log('已有 ' + 已有备份.length + ' 个备份，本次不重复备份（最早那份是干净基线）')
}

原[SID] = {
  ok: false, fails: 1, reason: 'p4-smoke-test',
  at: new Date().toISOString(),
  orphanRisk: { seq: 83123, range: '1205-1231', at: new Date().toISOString(), reason: 'p4-smoke-test' },
}
fs.mkdirSync(path.dirname(STATUS), { recursive: true })
fs.writeFileSync(STATUS, JSON.stringify(原, null, 1))
console.log('已往 ' + SID + ' 塞入假孤儿（range 1205-1231）')

const port = process.env.DSH_PORT || '3099'
console.log('')
console.log('下一步（手动）：')
console.log('  1. 打开面板，会话 id 填 ' + SID + '（就是最近这个，通常已经是）')
console.log('  2. 应看到橙色一行「⚠ 上次裁切在替换范围 1205-1231 …」+ 修复按钮橙色边框')
console.log('  3. 点「尝试修复会话」→ 应提示「没有找到孤立事件（孤立事件 0 条）」，橙色提示消失')
console.log('')
console.log('  无头环境可以用：')
console.log('    curl -s -X POST http://127.0.0.1:' + port + '/dsh-log-prune/repair \\')
console.log('      -H "Content-Type: application/json" -d \'{"sid":"' + SID + '"}\'')
console.log('    cat ' + STATUS)
console.log('')
console.log('跑完记得恢复：node test/p4-smoke.mjs --restore')
