// 极简 semver：只服务于「宿主版本是否在 peer 区间」这类判断，不引依赖。
function parse(v) {
  const s = String(v || '').trim().replace(/^v/i, '')
  const [core, pre = ''] = s.split('-', 2)
  const nums = core.split('.').map((x) => Number(x) || 0)
  while (nums.length < 3) nums.push(0)
  return { nums, pre }
}
function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] - b.nums[i]
  if (a.pre === b.pre) return 0
  if (!a.pre) return 1
  if (!b.pre) return -1
  const pa = a.pre.split('.'), pb = b.pre.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y)
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d }
    else if (nx !== ny) return nx ? -1 : 1
    else if (x !== y) return x < y ? -1 : 1
  }
  return 0
}
// B13：宽松比较，给「GitHub 最新 tag vs 当前版本」用。允许任意段数（0.2.18.1-fix4）
// 与预发布标签；旧实现 map(Number) 把 '1-fix4' 变成 NaN→0，预发布版会被误报「有新版本」。
export function compareLoose(a, b) {
  const loose = (v) => {
    const s = String(v || '').trim().replace(/^v/i, '')
    const cut = s.indexOf('-')
    const core = cut >= 0 ? s.slice(0, cut) : s
    const pre = cut >= 0 ? s.slice(cut + 1) : ''
    const nums = core.split('.').map((x) => { const n = parseInt(x, 10); return Number.isFinite(n) ? n : 0 })
    return { nums, pre }
  }
  const x = loose(a), y = loose(b)
  const n = Math.max(x.nums.length, y.nums.length)
  for (let i = 0; i < n; i++) { const p = x.nums[i] || 0, q = y.nums[i] || 0; if (p !== q) return p - q }
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  const pa = x.pre.split('.'), pb = y.pre.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const m = pa[i], k = pb[i]
    if (m === undefined) return -1
    if (k === undefined) return 1
    const mn = /^\d+$/.test(m), kn = /^\d+$/.test(k)
    if (mn && kn) { const d = Number(m) - Number(k); if (d) return d }
    else if (mn !== kn) return mn ? -1 : 1
    else if (m !== k) return m < k ? -1 : 1
  }
  return 0
}
export function hostCompatible(v) {
  const p = parse(v)
  // 只接受 0.2.x；0.3.0-rc.1 虽然 semver 上 <0.3.0，但属于 0.3 系列，仍判不兼容
  if (p.nums[0] !== 0 || p.nums[1] !== 2) return false
  return cmp(p, parse('0.2.1-rc.2')) >= 0 && cmp(p, parse('0.3.0')) < 0
}
