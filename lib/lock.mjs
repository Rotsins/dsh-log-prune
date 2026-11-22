// 跨实例互斥：锁文件带 pid+token，release 只删自己的；目录默认放数据根 state/locks
import fs from 'node:fs'
import path from 'node:path'
import { resolveHome } from './home.mjs'

const DIR = process.env.DSH_LOG_PRUNE_LOCKDIR || path.join(resolveHome(), 'state', 'locks')
const held = new Map() // name -> token

function fileFor(name) { return path.join(DIR, 'log-prune-' + name + '.lock') }
function readLock(f) {
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j && typeof j === 'object' ? j : null } catch { return null }
}

export function tryLock(name, ttlMs = 90000) {
  if (held.has(name)) return false
  const f = fileFor(name)
  try { fs.mkdirSync(DIR, { recursive: true }) } catch {}
  try {
    const st = fs.statSync(f)
    // 只有 mtime 超过 TTL 才当 stale；删之前再看一眼内容，避免误删别人刚续期的锁
    if (Date.now() - st.mtimeMs > ttlMs) {
      const cur = readLock(f)
      if (!cur || !cur.token || Date.now() - (Number(cur.at) || 0) > ttlMs) {
        try { fs.unlinkSync(f) } catch {}
      }
    }
  } catch {}
  const token = process.pid + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  try {
    fs.writeFileSync(f, JSON.stringify({ pid: process.pid, token, at: Date.now() }), { flag: 'wx' })
    held.set(name, token)
    return true
  } catch { return false }
}

export function releaseLock(name) {
  const token = held.get(name)
  held.delete(name)
  if (!token) return
  const f = fileFor(name)
  const cur = readLock(f)
  if (cur && cur.token === token) {
    try { fs.unlinkSync(f) } catch {}
  }
}
