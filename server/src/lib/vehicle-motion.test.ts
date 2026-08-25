import assert from 'node:assert/strict'
import test from 'node:test'
import {
  advanceVehicleMotion,
  headwayHoldFactors,
  expressStopStationIds,
  reconcileVehicleForInsertedStation,
  segmentTravelMinutes,
  stationDwellMinutes,
  type MotionStation,
} from './vehicle-motion'

const stations: MotionStation[] = [
  { id: 'a', posX: 0, posY: 0 },
  { id: 'b', posX: 10, posY: 0 },
  { id: 'c', posX: 30, posY: 0 },
]

const fiveStations: MotionStation[] = [
  { id: 'a', posX: 0, posY: 0 },
  { id: 'b', posX: 10, posY: 0 },
  { id: 'c', posX: 20, posY: 0 },
  { id: 'd', posX: 30, posY: 0 },
  { id: 'e', posX: 40, posY: 0 },
]

test('급행 정차역은 한 칸씩 건너뛰어 고르되 종점은 항상 포함한다', () => {
  assert.deepEqual([...expressStopStationIds(fiveStations)], ['a', 'c', 'e'])

  const four = fiveStations.slice(0, 4)
  // 홀짝이 안 맞아도(a,c 선택 후 마지막 d가 안 걸리면) 종점 d를 추가로 포함한다.
  assert.deepEqual([...expressStopStationIds(four)], ['a', 'c', 'd'])

  // 역 3개(a,b,c)짜리 노선은 가운데 b를 건너뛰고 종점 a-c만 정차역이다.
  assert.deepEqual([...expressStopStationIds(stations)], ['a', 'c'])
})

test('급행도 노선을 따라 역을 하나씩 지나가며 이동한다 — 건너뛰는 역도 순간이동 없이 그 위치를 지난다', () => {
  const expressStops = expressStopStationIds(fiveStations) // {a, c, e}
  const abDuration = segmentTravelMinutes(fiveStations[0], fiveStations[1], 'SUBWAY') // a-b
  const bcDuration = segmentTravelMinutes(fiveStations[1], fiveStations[2], 'SUBWAY') // b-c
  assert.equal(abDuration, bcDuration) // 등간격 역이라 구간 소요시간이 같다

  // a에서 출발해 딱 b에 도착할 만큼만 전진 — 완행이라면 b에서 정차했을 시점.
  const atB = advanceVehicleMotion(fiveStations, {
    currentStationId: 'a',
    direction: 1,
    segmentProgressMinutes: 0,
  }, abDuration, 'SUBWAY', expressStops)

  // b를 건너뛰어 c로 순간이동한 게 아니라, 실제로 b 위치(x=10)를 지나가고 있어야 한다.
  assert.equal(atB.currentStationId, 'b')
  assert.equal(atB.x, 10)
  assert.equal(atB.isDwelling, false) // 정차역이 아니므로 서지 않는다
  assert.deepEqual(atB.arrivedStationIds, []) // 도착 이벤트(=탑승 처리 대상)에도 안 잡힌다

  // 계속 이어서(a→b→c) c에 도착할 만큼 전진하면, c는 정차역이라 실제로 선다.
  const atC = advanceVehicleMotion(fiveStations, {
    currentStationId: 'a',
    direction: 1,
    segmentProgressMinutes: 0,
  }, abDuration + bcDuration, 'SUBWAY', expressStops)
  assert.equal(atC.currentStationId, 'c')
  assert.equal(atC.x, 20)
  assert.equal(atC.isDwelling, true)
  assert.deepEqual(atC.arrivedStationIds, ['c'])
})

test('stopStationIds를 안 주면(완행) 모든 역에 정차한다 — 기존 동작 그대로', () => {
  const motion = advanceVehicleMotion(fiveStations, {
    currentStationId: 'a',
    direction: 1,
    segmentProgressMinutes: 0,
  }, 200, 'SUBWAY')

  assert.deepEqual(motion.arrivedStationIds.length > 0, true)
  for (const id of motion.arrivedStationIds) assert.ok(['a', 'b', 'c', 'd', 'e'].includes(id))
})

test('역간 거리와 교통수단에 따라 이동 시간이 달라진다', () => {
  const shortSubway = segmentTravelMinutes(stations[0], stations[1], 'SUBWAY')
  const longSubway = segmentTravelMinutes(stations[1], stations[2], 'SUBWAY')
  const shortBus = segmentTravelMinutes(stations[0], stations[1], 'BUS')

  assert.ok(longSubway > shortSubway)
  assert.ok(shortBus > shortSubway)
  assert.equal(shortSubway, 9.5)
  assert.equal(longSubway, 19)
  assert.equal(shortBus, 14)
})

test('10분 틱 경계에서도 차량은 구간 중간 위치를 이어서 이동한다', () => {
  const firstTick = advanceVehicleMotion(stations, {
    currentStationId: 'b',
    direction: 1,
    segmentProgressMinutes: 0,
  }, 10, 'SUBWAY')

  assert.equal(firstTick.currentStationId, 'b')
  assert.equal(firstTick.nextStationId, 'c')
  assert.equal(firstTick.segmentProgressMinutes, 10)
  assert.ok(firstTick.progress > 0 && firstTick.progress < 1)

  const continued = advanceVehicleMotion(stations, firstTick, 1, 'SUBWAY')
  assert.equal(continued.segmentProgressMinutes, 11)
  assert.ok(continued.progress > firstTick.progress)
})

test('한 틱 안에 도착한 역을 기록하고 종점에서 방향을 전환한다', () => {
  const motion = advanceVehicleMotion(stations, {
    currentStationId: 'a',
    direction: 1,
    segmentProgressMinutes: 8,
  }, 25, 'SUBWAY')

  assert.deepEqual(motion.arrivedStationIds, ['b', 'c'])
  assert.equal(motion.currentStationId, 'c')
  assert.equal(motion.nextStationId, 'b')
  assert.equal(motion.direction, -1)
  assert.ok(motion.segmentProgressMinutes > 0)
})

test('역 도착 후 승하차 시간만큼 정차한 뒤 다시 출발한다', () => {
  const arrived = advanceVehicleMotion(stations, {
    currentStationId: 'a',
    direction: 1,
    segmentProgressMinutes: 0,
  }, 9.5, 'SUBWAY')

  assert.equal(arrived.currentStationId, 'b')
  assert.equal(arrived.isDwelling, true)
  assert.equal(arrived.dwellRemainingMinutes, 1.5)
  assert.equal(arrived.x, 10)

  const stillDwelling = advanceVehicleMotion(stations, arrived, 1, 'SUBWAY')
  assert.equal(stillDwelling.currentStationId, 'b')
  assert.equal(stillDwelling.isDwelling, true)
  assert.equal(stillDwelling.dwellRemainingMinutes, 0.5)
  assert.equal(stillDwelling.x, 10)

  const departed = advanceVehicleMotion(stations, stillDwelling, 1, 'SUBWAY')
  assert.equal(departed.currentStationId, 'b')
  assert.equal(departed.isDwelling, false)
  assert.equal(departed.segmentProgressMinutes, 0.5)
  assert.ok((departed.x ?? 10) > 10)
  assert.equal(stationDwellMinutes('BUS'), 2.5)
})

// a-c 구간만 있던 노선(중간에 b가 없음)에 b를 끼워 넣는 시나리오.
// 예전 버그: 짧아진 새 구간 길이에 진행 분(min)이 그대로 클램프되어 차량이 b로 순간이동했다.
const lineWithoutB: MotionStation[] = [stations[0], stations[2]]

function assertClose(actual: number, expected: number, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) < epsilon, `expected ${actual} to be close to ${expected}`)
}

test('삽입 지점 이전을 지나던 차량은 출발역에 남아 물리적 위치를 유지한다', () => {
  // a→c 28.5분 구간(거리30/속도1.05, 클램프 없음) 중 7분 경과 = 실제 이동 거리 7.368..., 아직 b(거리 10) 전이다.
  const fix = reconcileVehicleForInsertedStation(
    lineWithoutB,
    { currentStationId: 'a', direction: 1, segmentProgressMinutes: 7 },
    ['a', 'c'],
    stations[1],
    'SUBWAY',
  )
  assert.ok(fix)
  assert.equal(fix.currentStationId, 'a')
  assert.equal(fix.segmentProgressMinutes, 7)

  // 새 역이 반영된 노선에서 다시 위치를 구하면 순간이동 없이 같은 물리적 지점에 있어야 한다.
  const after = advanceVehicleMotion(stations, { currentStationId: 'a', direction: 1, segmentProgressMinutes: fix.segmentProgressMinutes }, 0, 'SUBWAY')
  assertClose(after.x ?? NaN, 10 * (7 / 9.5))
})

test('삽입 지점을 이미 지난 차량은 새 역을 출발점 삼아 남은 구간을 이어간다', () => {
  // a→c 28.5분 구간 중 14분 경과 = 실제 이동 거리 14.736..., b(거리 10)를 이미 지난 상태.
  const fix = reconcileVehicleForInsertedStation(
    lineWithoutB,
    { currentStationId: 'a', direction: 1, segmentProgressMinutes: 14 },
    ['a', 'c'],
    stations[1],
    'SUBWAY',
  )
  assert.ok(fix)
  assert.equal(fix.currentStationId, 'b')
  assert.equal(fix.segmentProgressMinutes, 4.5)

  // 새 역이 반영된 노선에서 다시 위치를 구하면 순간이동 없이 같은 물리적 지점에 있어야 한다.
  const after = advanceVehicleMotion(stations, { currentStationId: 'b', direction: 1, segmentProgressMinutes: fix.segmentProgressMinutes }, 0, 'SUBWAY')
  assertClose(after.x ?? NaN, 10 + 20 * (4.5 / 19))
})

test('정차 중이거나 다른 구간을 지나는 차량은 삽입에 영향받지 않는다', () => {
  const dwelling = reconcileVehicleForInsertedStation(
    lineWithoutB,
    { currentStationId: 'a', direction: 1, segmentProgressMinutes: -1.5 },
    ['a', 'c'],
    stations[1],
    'SUBWAY',
  )
  assert.equal(dwelling, null)

  const unrelatedSegment = reconcileVehicleForInsertedStation(
    stations,
    { currentStationId: 'b', direction: 1, segmentProgressMinutes: 5 },
    ['a', 'c'],
    { id: 'd', posX: 20, posY: 20 },
    'SUBWAY',
  )
  assert.equal(unrelatedSegment, null)
})
const LINE: MotionStation[] = [
  { id: 'a', posX: 0, posY: 0 },
  { id: 'b', posX: 20, posY: 0 },
  { id: 'c', posX: 40, posY: 0 },
]
const at = (id: string, station: string, progress: number, direction = 1) =>
  ({ id, currentStationId: station, direction, segmentProgressMinutes: progress })

test('한 대뿐이면 늦출 이유가 없다', () => {
  assert.equal(headwayHoldFactors(LINE, 'SUBWAY', [at('v1', 'a', 0)]).size, 0)
})

test('같은 자리에 겹친 차량은 뒤차만 늦춰 떼어놓는다', () => {
  const bunched = [at('v1', 'a', 0), at('v2', 'a', 0), at('v3', 'a', 0)]
  const factors = headwayHoldFactors(LINE, 'SUBWAY', bunched)
  // 셋 중 맨 앞(간격이 한 바퀴만큼 열린 차량) 하나는 정상 속도로 남는다
  assert.equal(factors.size, 2)
  for (const f of factors.values()) assert.ok(f > 0 && f < 1, `배수 ${f}`)
})

test('앞차와 가까울수록 더 많이 늦춘다 (0.55 아래로는 안 내려간다)', () => {
  const tight = headwayHoldFactors(LINE, 'SUBWAY', [at('v1', 'a', 0), at('v2', 'a', 0.5)])
  const loose = headwayHoldFactors(LINE, 'SUBWAY', [at('v1', 'a', 0), at('v2', 'a', 6)])
  assert.ok(tight.get('v1')! < loose.get('v1')!, '가까울수록 더 늦춰야 한다')
  for (const f of [...tight.values(), ...loose.values()]) assert.ok(f >= 0.55, `하한 위반 ${f}`)
})

test('붙어 출발한 차량도 굴리다 보면 고르게 퍼지고, 퍼진 뒤엔 아무도 안 늦춘다', () => {
  // 같은 자리에서 출발한 세 대를 늦춤 배수대로 계속 굴린다
  const v = [at('v1', 'a', 0), at('v2', 'a', 0), at('v3', 'a', 0)]
  const advance = (steps: number) => {
    for (let i = 0; i < steps; i += 1) {
      const f = headwayHoldFactors(LINE, 'SUBWAY', v)
      for (const item of v) item.segmentProgressMinutes += 0.5 * (f.get(item.id) ?? 1)
    }
  }
  advance(400)
  const spread = v.map(item => item.segmentProgressMinutes).sort((a, b) => a - b)
  assert.ok(spread[2] - spread[0] > 5, `아직 뭉쳐 있다: ${JSON.stringify(spread)}`)

  // 충분히 퍼진 뒤에는 붙잡는 차량이 없거나, 있어도 거의 정상 속도다
  for (const f of headwayHoldFactors(LINE, 'SUBWAY', v).values()) {
    assert.ok(f > 0.9, `수렴 후에도 과하게 늦춤: ${f}`)
  }
})
