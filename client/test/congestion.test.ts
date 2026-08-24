import assert from 'node:assert/strict'
import test from 'node:test'

import {
  congestedSegments,
  congestionHeat,
  CONGESTION_SATURATED,
  CONGESTION_WARN,
} from '../src/congestion'
import type { Station } from '../src/api/game'

const at = (id: string): Station =>
  ({ id, name: id, type: 'RESIDENTIAL', capacity: 180, posX: 0, posY: 0 })

const LINE = [at('a'), at('b'), at('c'), at('d')]

test('한산한 노선에는 혼잡 구간이 없다', () => {
  const quiet = new Map(LINE.map(s => [s.id, 0.2]))
  assert.deepEqual(congestedSegments(LINE, quiet), [])
})

test('구간 혼잡도는 양 끝 역 중 더 붐비는 쪽이다', () => {
  // b만 포화. b에 붙은 두 구간(a-b, b-c)이 함께 물들어야 「이 대목이 막혔다」가 보인다.
  const map = new Map([['a', 0.1], ['b', 1], ['c', 0.1], ['d', 0.1]])
  const hot = congestedSegments(LINE, map)
  assert.deepEqual(hot.map(h => h.key), ['a-b', 'b-c'])
  for (const h of hot) assert.equal(h.congestion, 1)
})

test('임계값 아래는 버리고 경계값은 살린다', () => {
  const edge = new Map([['a', CONGESTION_WARN], ['b', CONGESTION_WARN - 0.001], ['c', 0], ['d', 0]])
  assert.deepEqual(congestedSegments(LINE, edge).map(h => h.key), ['a-b'])
})

test('혼잡도를 모르는 역은 0으로 본다', () => {
  assert.deepEqual(congestedSegments(LINE, new Map()), [])
})

test('역이 하나뿐이면 구간이 없다', () => {
  assert.deepEqual(congestedSegments([at('a')], new Map([['a', 1]])), [])
})

test('열기는 주의(주황)에서 포화(빨강)로 넘어간다', () => {
  const warn = congestionHeat(CONGESTION_WARN)
  const full = congestionHeat(CONGESTION_SATURATED)
  assert.equal(warn.t, 0)
  assert.equal(full.t, 1)
  // 역 혼잡 링(.warnRing #e8a13c / .saturatedRing #d64541)과 같은 두 끝점이어야 한다
  assert.equal(warn.color, 'rgb(232 161 60)')
  assert.equal(full.color, 'rgb(214 69 65)')
  // 중간은 두 색 사이 어딘가 — 단조롭게 빨강 쪽으로 간다
  const mid = congestionHeat((CONGESTION_WARN + CONGESTION_SATURATED) / 2)
  assert.ok(mid.t > 0 && mid.t < 1)
  assert.notEqual(mid.color, warn.color)
  assert.notEqual(mid.color, full.color)
})

test('범위를 벗어난 혼잡도도 양 끝으로 잘린다', () => {
  assert.equal(congestionHeat(0).t, 0)
  assert.equal(congestionHeat(-5).t, 0)
  assert.equal(congestionHeat(99).t, 1)
  assert.equal(congestionHeat(NaN).t, 0)
})
