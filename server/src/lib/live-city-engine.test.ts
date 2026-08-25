import assert from 'node:assert/strict'
import test from 'node:test'
import { syncEngineClockToWallTime, type EngineClock } from './live-city-engine'
import { SIM } from '@/types/game'

const TICK = SIM.LIVE_TICK_MS
/** live-city-engine.ts의 MAX_CLOCK_CATCHUP_MS와 같은 값 */
const MAX_CATCHUP = TICK * 4
const NOW = 1_800_000_000_000

const clock = (lastTickAtMs: number, economyClockAccumMs: number): EngineClock =>
  ({ lastTickAtMs, economyClockAccumMs })

/** 엔진이 "안다고 보는 시각" — 이 값이 벽시계에 붙어 있어야 한다 */
const knownTime = (engine: EngineClock) => engine.lastTickAtMs + engine.economyClockAccumMs

test('시계가 이미 벽시계에 맞으면 건드리지 않는다', () => {
  const engine = clock(NOW - TICK, TICK)
  syncEngineClockToWallTime(engine, NOW)
  assert.equal(engine.economyClockAccumMs, TICK)
  assert.equal(knownTime(engine), NOW)
})

test('뒤처진 만큼 채워 벽시계에 맞춘다 — 이게 없으면 syncCityClock이 같은 도시를 이중으로 틱한다', () => {
  // 부팅 때 이미 9초 밀린 lastTickAt을 물려받은 상황
  const engine = clock(NOW - 9_000, 0)
  syncEngineClockToWallTime(engine, NOW)
  assert.equal(engine.economyClockAccumMs, 9_000)
  assert.equal(knownTime(engine), NOW)
  // 밀린 9초는 3틱으로 소비되므로 flush 뒤 lastTickAt이 벽시계에 붙는다
  assert.equal(Math.floor(engine.economyClockAccumMs / TICK), 3)
})

test('한 번에 갚는 양은 상한을 넘지 않는다 — 밀린 도시를 몰아서 돌리지 않도록', () => {
  const engine = clock(NOW - 600_000, 0)
  syncEngineClockToWallTime(engine, NOW)
  assert.equal(engine.economyClockAccumMs, MAX_CATCHUP)
  // 남은 적자는 다음 flush에서 마저 갚는다
  assert.ok(knownTime(engine) < NOW)
})

test('앞서 있으면 깎아낸다 — 락을 기다리는 동안 누적분이 실제 흐른 시간보다 커질 수 있다', () => {
  // 락 대기 20초 동안 advanceFrame이 계속 쌓아 시계가 벽시계를 앞지른 상황
  const engine = clock(NOW - 1_000, 21_000)
  syncEngineClockToWallTime(engine, NOW)
  assert.equal(engine.economyClockAccumMs, 1_000)
  assert.equal(knownTime(engine), NOW)
})

test('깎아내도 누적분이 음수가 되지 않는다', () => {
  const engine = clock(NOW + 60_000, 1_000)
  syncEngineClockToWallTime(engine, NOW)
  assert.equal(engine.economyClockAccumMs, 0)
})

test('여러 번 불러도 결과가 달라지지 않는다 (멱등)', () => {
  const engine = clock(NOW - 5_000, 0)
  syncEngineClockToWallTime(engine, NOW)
  const once = { ...engine }
  syncEngineClockToWallTime(engine, NOW)
  assert.deepEqual(engine, once)
})
