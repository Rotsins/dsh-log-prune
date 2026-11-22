// E1 跨包回归：offline-clean 的 frame-pack 与工具箱 frame-writer 必须逐字节一致
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { frameTexts } from '../lib/frame-pack.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const sibling = path.join(here, '..', '..', 'dsh-toolbox', 'lib', 'frame-writer.mjs')
const skip = typeof zlib.zstdCompressSync !== 'function' ? '当前 Node 无 zstd'
  : (!fs.existsSync(sibling) ? '同目录没有 dsh-toolbox（打包安装后跳过）' : false)

test('与工具箱 frame-writer 的批帧产物逐字节一致', { skip }, async () => {
  const { packSessionFrames } = await import(pathToFileURL(sibling).href)
  const header = JSON.stringify({ type: 'session', seq: -1, sid: 'cross' })
  const lines = [header, ...Array.from({ length: 1234 }, (_, i) => JSON.stringify({ type: 'message', seq: i, data: { t: 'y'.repeat(30) } }))]
  const mine = Buffer.concat(frameTexts(lines).map((t) => zlib.zstdCompressSync(Buffer.from(t))))
  const theirs = packSessionFrames(lines).buf
  assert.equal(mine.equals(theirs), true, '两份批帧实现产出的字节不同')
})
