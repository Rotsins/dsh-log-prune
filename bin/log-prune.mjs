#!/usr/bin/env node
// dsh-log-prune 命令行：全局重置 / 清掉某个会话的覆盖
// 用法：
//   node <plugin-dir>/bin/log-prune.mjs reset-global
//   node <plugin-dir>/bin/log-prune.mjs reset-session <session-id>
//   node <plugin-dir>/bin/log-prune.mjs list
import { saveConfig, DEFAULTS, SESSIONS_PATH, CONFIG_PATH } from '../lib/config.mjs'
import { clearSessionOverride, loadSessions } from '../lib/config.mjs'

const [cmd, arg] = process.argv.slice(2)
if (cmd === 'reset-global') {
  saveConfig(DEFAULTS)
  console.log('已把全局配置重置为默认值：' + CONFIG_PATH)
  console.log('会话覆盖不受影响；要一并清掉用 reset-session <sid> 逐个清')
} else if (cmd === 'reset-session') {
  if (!arg) { console.error('用法：reset-session <session-id>'); process.exit(2) }
  const ok = clearSessionOverride(arg)
  console.log(ok ? '已删除该会话的覆盖，改为跟随全局：' + arg : '该会话本来就没有覆盖：' + arg)
} else if (cmd === 'list') {
  const map = loadSessions()
  const ids = Object.keys(map)
  console.log('全局：' + CONFIG_PATH)
  console.log('会话覆盖：' + SESSIONS_PATH)
  if (!ids.length) console.log('（没有会话覆盖）')
  for (const id of ids) console.log(id + '  ' + JSON.stringify(map[id]))
} else {
  console.error('用法：log-prune.mjs reset-global | reset-session <session-id> | list')
  process.exit(2)
}
