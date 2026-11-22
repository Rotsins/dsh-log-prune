// 会话写回的统一批帧规则：首帧恰好一行 header，其余每 chunk 行一帧。
// offline-clean 与 dsh-toolbox/lib/frame-writer 必须逐字节一致（test/frame-pack.test.mjs 跨包比对）。
export const DEFAULT_FRAME_CHUNK = 500

export function frameTexts(lines, chunk = DEFAULT_FRAME_CHUNK) {
  if (!Array.isArray(lines) || !lines.length) throw new Error('没有可写帧')
  const c = Math.max(1, Math.floor(Number(chunk) || DEFAULT_FRAME_CHUNK))
  const out = [lines[0] + '\n']
  for (let i = 1; i < lines.length; i += c) out.push(lines.slice(i, i + c).join('\n') + '\n')
  return out
}
