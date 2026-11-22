// S5：进程控制共用实现（systemd 探测 / systemd-run 参数 / Windows 计划任务）
// offline-clean 与 archive-clean 原来各写一份，能力还不一致；这里只做「参数与探测」，
// 不接管调用方的 stop/restart 流程，避免改变行为。
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'

// 找到当前活跃的 systemd 单元（系统级优先，其次 --user）
export function detectSystemdUnit({ platform = process.platform, env = process.env, unit = null } = {}) {
  if (platform !== 'linux') return null
  const u = unit || (env.DSH_SYSTEMD_UNIT === '' ? '' : (env.DSH_SYSTEMD_UNIT || 'dsh.service'))
  if (!u) return null
  for (const userMode of [false, true]) {
    try {
      execFileSync('systemctl', [...(userMode ? ['--user'] : []), 'is-active', '--quiet', u], { stdio: 'ignore' })
      return { unit: u, userMode }
    } catch {}
  }
  return null
}

export function canSystemd({ platform = process.platform } = {}) {
  if (platform !== 'linux') return false
  try {
    const st = spawnSync('systemctl', ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 5000 })
    return !st.error && st.status === 0
  } catch { return false }
}

export function systemdUserMode(unit = process.env.DSH_SYSTEMD_UNIT || 'dsh.service') {
  try {
    const st = spawnSync('systemctl', ['--user', 'is-active', '--quiet', unit], { stdio: 'ignore', windowsHide: true, timeout: 5000 })
    return !st.error && st.status === 0
  } catch { return false }
}

export function systemctlArgs(unit, userMode, action) {
  return [...(userMode ? ['--user'] : []), action, unit]
}

// systemd-run 参数；onActive 为空表示立即执行（不带 --on-active）
export function systemdRunArgs({ unit, userMode = false, exe, script, args = [], onActive = null, killMode = null, collect = false, setenv = null }) {
  const out = [...(userMode ? ['--user'] : [])]
  if (onActive != null) out.push('--on-active=' + onActive)
  out.push('--unit=' + unit)
  if (collect) out.push('--collect')
  if (killMode) out.push('--property=KillMode=' + killMode)
  if (setenv) for (const [k, v] of Object.entries(setenv)) out.push('--setenv=' + k + '=' + v)
  out.push(exe, script, ...args)
  return out
}

export function systemdRunRaw({ unit, userMode = false, onActive = null, command = [] }) {
  const out = [...(userMode ? ['--user'] : [])]
  if (onActive != null) out.push('--on-active=' + onActive)
  out.push('--unit=' + unit)
  out.push(...command)
  return out
}

// Windows 一次性重启任务：任务名、/st 时间、bat 路径与内容
export function windowsRestartParts({ cmd, handshakeFile, home, prefix = 'dsh-restart', delayMs = 8000, root = process.env.SystemRoot || 'C:\\Windows' }) {
  const at = new Date(Math.ceil((Date.now() + delayMs) / 60000) * 60000)
  const p2 = (n) => String(n).padStart(2, '0')
  // F5（2026-11-21）：/st 单独给时刻时 schtasks 按「今天」解释，跨过午夜就永远不触发，
  // 必须同时给 /sd（offline-clean 的死亡保险丝一直是这么写的）。
  const sd = at.getFullYear() + '-' + p2(at.getMonth() + 1) + '-' + p2(at.getDate())
  const hhmm = p2(at.getHours()) + ':' + p2(at.getMinutes())
  const tn = prefix + '-' + Date.now()
  const batBody = cmd + '\r\nschtasks /delete /f /tn "' + tn + '"\r\ndel /q "' + handshakeFile + '"\r\n'
  const preferred = path.join(root, 'Temp', prefix + '-' + Date.now() + '.cmd')
  return { at, sd, hhmm, tn, batBody, preferred, fallback: path.join(home, 'state', 'restart-dsh.cmd') }
}
