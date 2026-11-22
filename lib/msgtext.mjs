// 5.2（2026-11-19）：消息文本提取 —— 从 index.js 抽出的纯函数，供裁切/门牌/长文共用。
// 只搬不改：charLen 与 messageText 的原实现与行为保持不变。

// 按码点数统计 text 块长度（汉字算 1）
export function charLen(msg) {
  let n = 0
  for (const block of msg?.content ?? []) if (block.type === 'text') n += Array.from(block.text ?? '').length
  return n
}

// 从消息对象取正文（content 可能是字符串或 block 数组；只收 text 块）
export function messageText(m) {
  if (!m) return ''
  if (typeof m === 'string') return m
  const c = m.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n')
  return ''
}
