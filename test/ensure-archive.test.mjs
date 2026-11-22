// O5（2026-11-18）：归档闸门失败冷却单测
// 关键：DSH_ARCHIVE_SCRIPT 指向不存在的脚本，第一次 spawn 失败，第二次应命中 5 分钟冷却
process.env.DSH_ARCHIVE_SCRIPT = '/nonexistent/archive-sessions.mjs'
process.env.DSH_ARCHIVE_WM = '/nonexistent/archive-watermark.json'
import test from 'node:test'
import assert from 'node:assert/strict'
const { ensureArchived } = await import('../lib/ensure-archive.mjs')

test('闸门失败后 5 分钟内冷却，不再 spawn', async () => {
  const t0 = Date.now()
  const a = await ensureArchived('test-sid-cool', 100)
  assert.equal(a.ok, false)
  assert.equal(a.ran, true)
  const b = await ensureArchived('test-sid-cool', 100)
  assert.equal(b.ok, false)
  assert.equal(b.ran, false)
  assert.match(String(b.why), /冷却/)
  assert.ok(Date.now() - t0 < 5000, '第二次应立即返回（冷却），不 spawn')
})

