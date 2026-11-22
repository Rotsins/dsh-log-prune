// S3：log-prune 内部重复的时间戳工具收口（行为与各副本逐字一致）
const pad = (n, l = 2) => String(n).padStart(l, '0')

// 日志时间统一本地时间；withMs=true 时带毫秒（offline-clean 的 run.log 用）
export function tsLocal(d = new Date(), withMs = false) {
  const base = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
  return withMs ? base + '.' + pad(d.getMilliseconds(), 3) : base
}

