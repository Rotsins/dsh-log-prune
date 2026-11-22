// 启动自检：一次说清当前 Node / zstd 能力，避免用户点不同按钮收到不同报错。
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { timezoneSupport } from './daycut.mjs'

export function checkCapabilities() {
  const zstdWrite = typeof zlib.zstdCompressSync === 'function'
  const zstdRead = typeof zlib.zstdDecompressSync === 'function'
  let zstdCli = false
  try {
    const st = spawnSync('zstd', ['--version'], { stdio: 'ignore', timeout: 3000, windowsHide: true })
    zstdCli = !st.error && st.status === 0
  } catch {}
  // V5：small-icu / 无 ICU 的构建会忽略 timeZone，日期口径会错一天，启动时就报出来
  const tz = timezoneSupport()
  return { node: process.version, zstdWrite, zstdRead, zstdCli, tz, ok: zstdWrite || zstdCli }
}
