import assert from 'node:assert/strict'
import test from 'node:test'
import type { GameLine, Station, Vehicle } from '../src/api/game'
import { locateVehicle } from '../src/vehicle-motion'

function station(id: string, posX: number): Station {
  return { id, name: id, type: 'RESIDENTIAL', capacity: 1000, posX, posY: 0 }
}

function lineWith(stations: Station[], vehicle: Vehicle, mode: GameLine['mode'] = 'SUBWAY'): GameLine {
  return {
    id: 'line',
    playerId: null,
    color: 'BLUE',
    mode,
    name: '1호선',
    status: 'OPERATING',
    depotX: stations[0]?.posX ?? 0,
    depotY: 0,
    lineStations: stations.map((item, order) => ({ stationId: item.id, order, station: item })),
    vehicles: [vehicle],
    policies: [],
  }
}

function vehicle(overrides: Partial<Vehicle> = {}): Vehicle {
  return {
    id: 'vehicle',
    capacity: 120,
    status: 'OPERATING',
    isSpare: false,
    currentStationId: 'a',
    headwayMinutes: 8,
    direction: 1,
    segmentProgressMinutes: 3,
    isExpress: false,
    ...overrides,
  }
}

test('지하철과 버스 모두 100ms 서버 샘플 사이 위치를 화면 프레임마다 연속 투영한다', () => {
  for (const mode of ['SUBWAY', 'BUS'] as const) {
    const activeVehicle = vehicle()
    const line = lineWith([station('a', 0), station('b', 20)], activeVehicle, mode)
    const positions = Array.from({ length: 7 }, (_, frame) => {
      const elapsedGameMinutes = frame * (10 / 3) / 60
      return locateVehicle(line, activeVehicle, elapsedGameMinutes).x
    })

    assert.ok(positions.every((x): x is number => x != null))
    for (let index = 1; index < positions.length; index += 1) {
      assert.ok(positions[index] > positions[index - 1], `${mode}: ${positions[index - 1]} -> ${positions[index]}`)
    }
  }
})

test('급행 차량은 통과역에서 멈추지 않고 다음 구간으로 이어서 투영한다', () => {
  const express = vehicle({ segmentProgressMinutes: 9, isExpress: true })
  const line = lineWith([station('a', 0), station('b', 10), station('c', 20)], express)
  const motion = locateVehicle(line, express, 1)

  assert.equal(motion.fromStation?.id, 'b')
  assert.equal(motion.isDwelling, false)
  assert.ok((motion.x ?? 0) > 10)
})
