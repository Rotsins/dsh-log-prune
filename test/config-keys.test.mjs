// S-c 回归：配置键有三处真源（config.mjs DEFAULTS / 模板占位符 / 面板 FIELDS），漏一处就报
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DEFAULTS, GLOBAL_KEYS, 保留注释更新 } from '../lib/config.mjs'

const tpl = fs.readFileSync(new URL('../templates/log-prune.yml.tpl', import.meta.url), 'utf8')
const tplKeys = [...tpl.matchAll(/^([A-Za-z0-9_.-]+): @@\1@@/gm)].map((m) => m[1])
const ui = fs.readFileSync(new URL('../lib/ui.js', import.meta.url), 'utf8')
const seg = ui.slice(ui.indexOf('var FIELDS'), ui.indexOf('var HINTS'))
const fieldKeys = [...seg.matchAll(/\['([A-Za-z][A-Za-z0-9_]*)',/g)].map((m) => m[1])
// 明确不在面板里出现的键（安全项/内部项），新增这类键要同步这份白名单
const NON_UI = new Set(['plateMerge', 'handoffDir', 'allowRemote', 'trustProxy', 'plainRedact', 'preArchiveRatio'])

test('模板占位符键集合 == DEFAULTS 键集合', () => {
  assert.deepEqual([...tplKeys].sort(), Object.keys(DEFAULTS).sort())
})

test('ui.js 的 GLOBAL_KEYS 与 config.mjs 完全一致', () => {
  const m = ui.match(/var GLOBAL_KEYS = \[([^\]]*)\]/)
  assert.ok(m, 'ui.js 里找不到 GLOBAL_KEYS')
  const keys = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  assert.deepEqual(keys.sort(), [...GLOBAL_KEYS].sort())
})

test('面板 FIELDS 里的键都必须是已知配置键', () => {
  assert.deepEqual(fieldKeys.filter((k) => !(k in DEFAULTS)), [])
})

test('每个 DEFAULTS 键要么在面板里，要么在 NON_UI 白名单里', () => {
  assert.deepEqual(Object.keys(DEFAULTS).filter((k) => !fieldKeys.includes(k) && !NON_UI.has(k)), [])
})

test('空值行保存后保留注释前空白，注释不会被读成值', () => {
  const src = 'summaryClientPath: ""    # 例：C:/x\nsummaryApiUrl: "" # 例：http://x\n'
  const out = 保留注释更新(src, { ...DEFAULTS, summaryClientPath: '', summaryApiUrl: '' })
  assert.match(out, /^summaryClientPath: ""    # 例：C:\/x$/m)
  assert.match(out, /^summaryApiUrl: "" # 例：http:\/\/x$/m)
  assert.doesNotMatch(out, /^summaryClientPath: ""#/m)
})
