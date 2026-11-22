// e2e.mjs —— 裁切轻索引/明文副本的端到端自测（不依赖宿主，跑：node test/e2e.mjs）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeWriter, readText, grepIndex, readIndex, hash8 } from '../lib/plain.mjs'

let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra ?? '') } }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-e2e-'))
const sid = 'e2e'
const day = '20261117'
const t = Date.parse('2026-11-17T10:00:00+08:00')
const rawLong = 'L'.repeat(5000) + 'TAIL'
const rawSecret = 'api_key: sk-abcdefghijklmnop1234 完成'
const write = makeWriter(root)

write(sid, () => day, [
  { seq: 1, time: t, role: 'assistant', type: 'a', text: '裁切日志分析：报错在这', arch: '' },
  { seq: 2, time: t, role: 'assistant', type: 'a', text: rawSecret, arch: '' },
  { seq: 3, time: t, role: 'assistant', type: 'a', text: rawLong, arch: '' },
], { maxChars: 100, keepDays: 30, redact: true, plainEnabled: true })

const dir = path.join(root, sid)
const idx = fs.readFileSync(path.join(dir, day + '.idx'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const txt = fs.readFileSync(path.join(dir, day + '.txt'), 'utf8')

ok('索引写 3 条', idx.length === 3, idx.length)
ok('明文含脱敏', txt.includes('[REDACTED]') && !txt.includes('sk-abcdefghijklmnop1234'))
ok('明文含截断标记', txt.includes('已截断'))
ok('clip 标记', idx.find((r) => r.seq === 3)?.clip === 1)
ok('h 按原文算', idx.find((r) => r.seq === 3)?.h === hash8(rawLong))

const g = grepIndex(root, sid, '裁切 日志')
ok('多词检索命中', g.ok && g.count === 1, JSON.stringify(g).slice(0, 80))
ok('多词未命中', !grepIndex(root, sid, '裁切 无关').ok)

const readPlain = async (f, want) => {
  const m = new Map()
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!l) continue
    const j = JSON.parse(l)
    if (want.has(j.seq)) m.set(j.seq, j.text)
  }
  return m
}
const plainFileFor = (r) => path.join(dir, day + '.txt')

const a = await readText(root, sid, 1, 2, async () => new Map(), { plainFileFor, readPlainTexts: readPlain })
ok('明文读取 + 无 hash 误报', a.ok && a.text.includes('报错在这') && !a.text.includes('hash 与索引不一致'))

const b = await readText(root, sid, 3, 3, async () => new Map([[3, rawLong]]), { plainFileFor, readPlainTexts: readPlain, archiveFileFor: () => '/fake/arch.日志' })
ok('clip 行取归档全文', b.text.includes('TAIL') && !b.text.includes('已截断'))

const c = await readText(root, sid, 3, 3, async () => new Map(), { plainFileFor, readPlainTexts: readPlain, archiveFileFor: () => '' })
ok('无归档回落残本', c.text.includes('已截断'))

const row1 = idx.find((r) => r.seq === 1)
row1.h = 'deadbeef'
fs.writeFileSync(path.join(dir, day + '.idx'), JSON.stringify(idx.find((r) => r.seq === 1)) + '\n' + idx.filter((r) => r.seq !== 1).map((r) => JSON.stringify(r)).join('\n') + '\n')
const d = await readText(root, sid, 1, 1, async () => new Map(), { plainFileFor, readPlainTexts: readPlain })
ok('hash 不一致提示', d.text.includes('hash 与索引不一致'))

const writeOff = makeWriter(root)
writeOff('e2e-off', () => day, [{ seq: 9, time: t, role: 'user', type: 'a', text: '结论', arch: '' }], { plainEnabled: false })
ok('plainEnabled=false 不写明文', !fs.existsSync(path.join(root, 'e2e-off', day + '.txt')) && fs.existsSync(path.join(root, 'e2e-off', day + '.idx')))

const oldFile = path.join(dir, '20200101.idx')
fs.writeFileSync(oldFile, '')
const past = new Date(Date.now() - 40 * 86400000)
fs.utimesSync(oldFile, past, past)
makeWriter(root)(sid, () => day, [{ seq: 4, time: t, role: 'user', type: 'a', text: '触发清理', arch: '' }])
ok('过期索引被清理', !fs.existsSync(oldFile))


// O7（2026-11-18）：同一归档文件同时被 fileOf 和 fallbackOf 命中时，两条都要拿到全文（原来前一条退化成首句）
{
  const root7 = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-e2e-o7-'))
  const sid7 = 'o7'
  const dir7 = path.join(root7, sid7)
  fs.mkdirSync(dir7, { recursive: true })
  const archA = path.join(dir7, 'archA.日志')
  const t7 = Date.now()
  const rows7 = [
    { seq: 1, time: t7, role: 'assistant', type: 'a', text: 'HEAD1', head: 'HEAD1', arch: archA, clip: 0, h: '' },
    { seq: 2, time: t7, role: 'assistant', type: 'a', text: 'HEAD2', head: 'HEAD2', arch: '', clip: 1, h: '' },
  ]
  fs.writeFileSync(path.join(dir7, '20261118.idx'), rows7.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const archive = new Map([[1, 'FULL-ONE-正文完整'], [2, 'FULL-TWO-正文完整']])
  const res7 = await readText(root7, sid7, 1, 2, async (file, want) => new Map([...archive].filter(([k]) => want.has(k))), {
    plainFileFor: () => path.join(dir7, '20261118.txt'),
    readPlainTexts: async () => new Map(),
    archiveFileFor: () => archA,
  })
  ok('O7 同归档双来源都取全文', res7.ok && res7.text.includes('FULL-ONE-正文完整') && res7.text.includes('FULL-TWO-正文完整'))
  fs.rmSync(root7, { recursive: true, force: true })
}
fs.rmSync(root, { recursive: true, force: true })
console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail ? 1 : 0)
