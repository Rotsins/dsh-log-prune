// zstd-safe.mjs —— 多帧 zstd 统一解码/压缩（2026-11-20，R2-H5 / R1-B3）
// 顺序：fzstd（纯 JS，能解多帧）→ 系统 zstd CLI → Node 内置（部分版本只解首帧，
// 仅当前两路都不可用时兜底；调用方需自行核对行数/覆盖范围）。
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

// F2（2026-11-21）：Windows 上 import(绝对路径) 会被当裸模块名解析并抛错，
// 必须转成 file:// URL（与 watcher 的 toSpecifier 同口径）。原写法让 fzstd 永远是 null，
// 读改写路径只能走 zstd CLI，Windows 默认没有 → 归档清理全断。
let fzstd = null
let FzstdDecompress = null
async function loadFzstd() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const home = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : null
  const cands = [process.env.DSH_FZSTD_MODULE, path.join(here, 'vendor', 'fzstd.mjs')]
  if (home) cands.push(path.join(home, 'plugins', 'dsh-log-prune', 'lib', 'vendor', 'fzstd.mjs'))
  for (const c of cands) {
    if (!c) continue
    try {
      if (!fs.existsSync(c)) continue
      const mod = await import(pathToFileURL(c).href)
      if (typeof mod.decompress === 'function') {
        if (typeof mod.Decompress === 'function') FzstdDecompress = mod.Decompress
        return mod.decompress
      }
    } catch {}
  }
  return null
}
fzstd = await loadFzstd()

// 供 archive-clean 等模块复用，避免再各写一份加载逻辑（本次就写歪了一份）
export const fzstdLoaded = () => fzstd

const MAX_TEXT_BYTES = Math.max(1, Number(process.env.DSH_ARCHIVE_MAX_TEXT_MB) || 512) * 1024 * 1024
function cap(b) {
  if (b && b.length > MAX_TEXT_BYTES) throw new Error('解压后约 ' + Math.round(b.length / 1048576) + 'MB，超过上限 ' + Math.round(MAX_TEXT_BYTES / 1048576) + 'MB（可调 DSH_ARCHIVE_MAX_TEXT_MB）')
  return b
}
// F7（2026-11-21）：流式解压，累计输出超上限立刻中止，不再「整包解完再判上限」。
// 返回 null 表示 fzstd 不可用或解码出错，交回原来的兜底链（保持旧行为）。
export function unzstdLimited(buf, limit = MAX_TEXT_BYTES) {
  if (!fzstd || typeof FzstdDecompress !== 'function') return null
  const chunks = []
  let total = 0
  let over = false
  const d = new FzstdDecompress((c) => {
    total += c.length
    if (total > limit) { over = true; throw new Error('LIMIT') }
    chunks.push(Buffer.from(c))
  })
  try {
    d.push(new Uint8Array(buf), true)
  } catch (e) {
    if (over) throw new Error('解压后超过上限 ' + Math.round(limit / 1048576) + 'MB（可调 DSH_ARCHIVE_MAX_TEXT_MB）')
    return null
  }
  return Buffer.concat(chunks)
}

// allowZlib=false 的路径（读改写）不允许内置只解首帧的兜底，宁可报错
export function unzstd(buf, { allowZlib = true } = {}) {
  if (fzstd) {
    const limited = unzstdLimited(buf)
    if (limited) return limited
    try { return cap(Buffer.from(fzstd(new Uint8Array(buf)))) } catch (e) { if (/超过上限/.test(String(e && e.message))) throw e }
  }
  try { return execFileSync('zstd', ['-dc'], { input: buf, maxBuffer: MAX_TEXT_BYTES, windowsHide: true }) } catch (e) {
    if (e && (e.code === 'ENOBUFS' || /maxBuffer/i.test(String(e.message)))) throw new Error('解压后超过上限 ' + Math.round(MAX_TEXT_BYTES / 1048576) + 'MB')
  }
  if (allowZlib && typeof zlib.zstdDecompressSync === 'function') { try { return cap(zlib.zstdDecompressSync(buf)) } catch (e) { if (/超过上限/.test(String(e && e.message))) throw e } }
  throw new Error(allowZlib ? 'zstd 解压失败：fzstd / CLI / 内置均不可用' : '没有可用的多帧安全 zstd 解压（保留 vendor/fzstd.mjs，或安装 zstd 命令行）')
}

export function compressZstd(buf) {
  if (typeof zlib.zstdCompressSync === 'function') { try { return zlib.zstdCompressSync(buf) } catch {} }
  return execFileSync('zstd', ['-q', '-c'], { input: buf, maxBuffer: 1 << 30, windowsHide: true })
}

