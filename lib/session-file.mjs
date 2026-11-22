// session-file.mjs —— 会话文件名适配（2026-11-19，B2/D3）
// 按形状匹配 session.v<N>.jsonl.zstd：优先 v4，否则取最大版本；都没有回落 v4。
// DSH 升会话 schema（v5+）时只需改这里，不再散落硬编码。

import fs from 'node:fs'

export function sessionFileName(dir) {
  let names = []
  try { names = fs.readdirSync(dir) } catch { return 'session.v4.jsonl.zstd' }
  const cands = []
  for (const f of names) {
    const m = f.match(/^session\.v(\d+)\.jsonl(\.zstd)?$/)
    if (m) cands.push({ f, v: Number(m[1]), plain: !m[2] })
  }
  if (!cands.length) return 'session.v4.jsonl.zstd'
  // 2026-11-19（N4）：取 schema 版本最高者——迁移期 v4/v5 共存时宿主读写的是最新那份
  // 2026-11-20 R1-B10：同版本时 zstd 优先，明文 .jsonl 只在没有 zstd 时回落
  cands.sort((a, b) => b.v - a.v || Number(a.plain) - Number(b.plain))
  return cands[0].f
}
