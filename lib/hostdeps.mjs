/**
 * lib/hostdeps.mjs —— 从宿主那棵树里取 `@deepseek-ai/*`（拿不到就退到"自己的依赖"）
 * ============================================================================
 * 🔴 为什么要有它（2026-10-16 一位用户递来的完整报告，本机也复现了）：
 *   `index.js` 顶部裸 import `@deepseek-ai/schemastery` 和 `@deepseek-ai/dsh-tools`，
 *   而它们在 package.json 里是 **optional peer** ⇒ 桌面版 profile（`autoInstallPeers: false`）
 *   **永远不装它们** ⇒ 插件整条不激活，DSH 只留一句
 *   `warning: 1 entry did not activate … failed to import` ✓
 *   （web profile 上之所以一直没事，是因为 profile 树里恰好有别的插件把它们 hoist 上来了 —— 这是运气 ✗）
 *   ⚠️ `dsh-tools` 自己还有 7 个顶层 import、其中 4 个是 peer ⇒ 光把它装上也救不回来 ✗。
 *
 * ⭐ 策略（两条一起走）：
 *   ① **优先从宿主那棵树里解析**（跟宿主用同一份，行为最一致）；
 *   ② 解析不到就 **bare import**（注：当前 package.json 没有 dependencies，桌面版 autoInstallPeers:false 下 schemastery/dsh-tools 拿不到 → 优雅降级，无 Config/设置页）；
 *   ③ `schemastery` 彻底拿不到 ⇒ 返回 null，**插件照常加载**（只是没有 Config、设置页降级）——
 *      **绝不因为一个 import 就让整条插件不激活** ✗✓。
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 插件自己那棵树（`dependencies` 装出来的那份）—— 用模块位置算，别依赖 cwd */
const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

/** 可能藏着宿主 `@deepseek-ai` 包的地方（不写死某一台机器，按可能性排序） */
export function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)

  // 桌面版（Windows）：依赖在 exe 同级的 resources/app.asar 里
  try {
    const exeDir = dirname(process.execPath)
    push(join(exeDir, 'resources', 'app.asar', 'node_modules', '@deepseek-ai'))
    push(join(exeDir, 'resources', 'app.asar.unpacked', 'node_modules', '@deepseek-ai'))
    push(join(exeDir, 'node_modules', '@deepseek-ai'))
  } catch {}

  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    // 桌面版可能叫别的包名（dsh-desktop / dsh-next…）⇒ 逐个看它们的 node_modules
    try {
      for (const n of readdirSync(join(npm, '@deepseek-ai'))) {
        push(join(npm, '@deepseek-ai', n, 'node_modules', '@deepseek-ai'))
      }
    } catch { /* 没有就算了 */ }
  }
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/local/lib/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai')

  // profile 树：有些机器上这些包是被别的插件 hoist 到 profile 根上的
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'))
    }
  } catch { /* 没有就算了 */ }

  // 插件自己那份（package.json 的 dependencies 装出来的）—— 放最后，前面优先"跟宿主同一份"
  push(SELF_MODULES)
  return out
}

/** 按包的 exports['.'] 找入口文件，返回 file:// URL */
function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string'
      ? dot
      : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch { return null }
}

/** 试从宿主树里 import 一个包；拿不到返回 null（失败原因写进 notes，方便远程排查） */
export async function fromHostTree(name, log = () => {}) {
  const fails = []
  for (const root of candidateRoots()) {
    if (root === SELF_MODULES) continue          // 自己那份交给下面的 bare import 处理
    const url = entryUrlFor(root, name)
    if (!url) continue
    try {
      const mod = await import(url)
      log(`${name}：从宿主树取到（${url.replace(/^file:\/\/\//, '')}）`)
      return mod
    } catch (e) { fails.push(`${e?.code || 'ERR'}:${root}`) }
  }
  if (fails.length) log(`${name}：宿主树里都不行（${fails.slice(0, 3).join(' ')}）`)
  return null
}
