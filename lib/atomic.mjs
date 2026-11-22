// 小文件原子写：先写同目录 tmp，再 rename 覆盖。
// 防止进程被杀/断电时留下半写 JSON/YAML（半写文件用户看到的就是状态错乱/配置读不出）。
import fs from 'node:fs'

export function writeFileAtomic(file, data) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  try {
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, file)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch {}
    throw e
  }
}

export function writeJsonAtomic(file, obj, space) {
  writeFileAtomic(file, JSON.stringify(obj, null, space))
}
