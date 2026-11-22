// 统一解析 DSH 数据根目录：显式环境变量优先，其次按平台找真实数据目录
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

export function resolveHome() {
  // 一律绝对化：DSH_HOME 若是相对路径，工作目录一变，状态/归档路径就全漂了（2026-11-16 二次审查）
  if (process.env.DSH_HOME) return resolve(process.env.DSH_HOME)
  const cands = process.platform === 'win32'
    ? ['C:\\data\\dsh', join(homedir(), '.dsh')]
    : ['/data/dsh', join(homedir(), '.dsh')]
  for (const c of cands) {
    if (existsSync(join(c, 'sessions')) || existsSync(join(c, 'state')) || existsSync(join(c, 'profiles'))) return c
  }
  // T5：两处都不存在时回落用户目录，不再返回写死的 /data/dsh 或 C:\data\dsh
  return join(homedir(), '.dsh')
}
