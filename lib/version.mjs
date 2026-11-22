// 版本唯一源：只改 package.json 的 version，这里和所有引用它的地方都会跟着变。
// 不要在别处再写死 0.2.x；文档/发布记录里的历史版本号保留不动。
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
export const PKG = (() => {
  try { return JSON.parse(fs.readFileSync(pkgPath, 'utf8')) } catch { return { version: '0.0.0' } }
})()
export const VERSION = String(PKG.version || '0.0.0')
