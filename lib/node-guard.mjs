// 全局运行门槛：Node >= 22.15 且内置 zstd。
// 低版本即使能完成在线裁切，后续清理/修复也没有 zstd 兜底，可能损坏会话，因此直接拒绝激活。
import zlib from 'node:zlib'

export const MIN_NODE = '22.15.0'

export function nodeRequirement(v = process.version, hasZstd = typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function') {
  const m = /^(\d+)\.(\d+)/.exec(String(v).replace(/^v/, ''))
  if (!m) return '无法识别 Node 版本 ' + v
  const major = Number(m[1])
  const minor = Number(m[2])
  if (major < 22 || (major === 22 && minor < 15)) return 'Node ' + v + ' 低于 22.15'
  if (!hasZstd) return 'Node ' + v + ' 缺少内置 zstd（23.0–23.7 请升级到 23.8+）'
  return ''
}
