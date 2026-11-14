// 统一解析 DSH 数据根目录：显式环境变量优先，其次按平台找真实数据目录
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export function resolveHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  const cands = process.platform === 'win32'
    ? ['C:\\data\\dsh', join(homedir(), '.dsh')]
    : ['~/.dsh', join(homedir(), '.dsh')]
  for (const c of cands) {
    if (existsSync(join(c, 'sessions')) || existsSync(join(c, 'state')) || existsSync(join(c, 'profiles'))) return c
  }
  return cands[0]
}
