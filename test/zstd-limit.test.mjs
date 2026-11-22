// F7 回归：流式解压必须与整体解压结果一致，且超限时提前中止
import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { unzstd, unzstdLimited } from '../lib/zstd-safe.mjs'

const hasZstd = typeof zlib.zstdCompressSync === 'function'

test('多帧流式解压与整体解压逐字一致', { skip: hasZstd ? false : '当前 Node 无 zstd' }, (t) => {
  const parts = ['header\n', 'b\n'.repeat(50), 'c\n'.repeat(2000)]
  const buf = Buffer.concat(parts.map((p) => zlib.zstdCompressSync(Buffer.from(p))))
  const limited = unzstdLimited(buf)
  if (limited == null) return t.skip('fzstd 未加载')
  assert.equal(limited.toString('utf8'), parts.join(''))
  assert.equal(unzstd(buf).toString('utf8'), parts.join(''))
})

test('输出超过上限时提前中止', { skip: hasZstd ? false : '当前 Node 无 zstd' }, (t) => {
  const buf = zlib.zstdCompressSync(Buffer.alloc(4096, 97))
  if (unzstdLimited(buf) == null) return t.skip('fzstd 未加载')
  assert.throws(() => unzstdLimited(buf, 1024), /上限/)
})
