// O1：静默 catch 盘点。只读扫描 lib/ bin/，按文件统计 catch 总数与空 catch 数，
// 输出 markdown，便于按模块分批处理。
import fs from 'node:fs'
import path from 'node:path'

const roots = process.argv.slice(2)
if (!roots.length) roots.push('lib', 'bin')
const rows = []
for (const root of roots) {
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f)
      const st = fs.statSync(p)
      if (st.isDirectory()) { walk(p); continue }
      if (!/\.(mjs|js)$/.test(f) || f.includes('.bak-')) continue
      const lines = fs.readFileSync(p, 'utf8').split('\n')
      let total = 0, empty = 0
      const spots = []
      lines.forEach((line, i) => {
        if (!/\bcatch\b/.test(line)) return
        total++
        const tail = line.slice(line.indexOf('catch'))
        if (/^catch(\s*\([^)]*\))?\s*\{\s*\}\s*;?\s*$/.test(tail.trim())) { empty++; spots.push(i + 1) }
      })
      if (total) rows.push({ file: p, total, empty, spots })
    }
  }
  walk(root)
}
rows.sort((a, b) => b.total - a.total)
console.log('| 文件 | catch | 空 catch | 空 catch 行 |')
console.log('|---|---:|---:|---|')
for (const r of rows) console.log('| ' + r.file + ' | ' + r.total + ' | ' + r.empty + ' | ' + r.spots.slice(0, 12).join(', ') + ' |')
console.log('\n合计：' + rows.reduce((a, r) => a + r.total, 0) + ' catch，空 ' + rows.reduce((a, r) => a + r.empty, 0))
