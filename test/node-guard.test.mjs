import test from 'node:test'
import assert from 'node:assert/strict'
import { nodeRequirement } from '../lib/node-guard.mjs'

test('Node 22.14 被拒绝', () => {
  assert.match(nodeRequirement('22.14.0', true), /低于 22\.15/)
})

test('Node 22.15 且有 zstd 通过', () => {
  assert.equal(nodeRequirement('22.15.0', true), '')
})

test('Node 23.0 没有内置 zstd 被拒绝', () => {
  assert.match(nodeRequirement('23.0.0', false), /缺少内置 zstd/)
})

test('当前 Node 满足要求', () => {
  assert.equal(nodeRequirement(), '')
})
