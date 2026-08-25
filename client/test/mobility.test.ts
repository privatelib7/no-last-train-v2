import assert from 'node:assert/strict'
import test from 'node:test'
import { getCityMap, pointInDistrict } from '../src/maps'
import {
  CITIZEN_ERRAND_RANGE,
  CITIZEN_WALK_RANGE,
  advanceCitizenJourneys,
  createCitizenJourneys,
  locateCitizen,
  pathStaysOnLand,
} from '../src/mobility'

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y)

const station = (id: string, posX: number, posY: number, type: 'RESIDENTIAL' | 'COMMERCIAL') => ({
  id,
  name: id.toUpperCase(),
  type,
  capacity: 1000,
  posX,
  posY,
})

const subwayLine = (stations: Array<ReturnType<typeof station>>) => ({
  id: 'line',
  playerId: null,
  color: 'RED' as const,
  mode: 'SUBWAY' as const,
  name: 'Line',
  status: 'OPERATING' as const,
  depotX: stations[0].posX,
  depotY: stations[0].posY,
  lineStations: stations.map((item, order) => ({ stationId: item.id, order, station: item })),
  vehicles: [],
  policies: [],
  actionLogs: [],
})

test('keeps ambient citizens visible when a city has no operating lines', () => {
  const map = getCityMap('SEOUL')
  const journeys = createCitizenJourneys({
    seed: 20260809,
    waitingCount: 5964,
    gameHour: 10,
    weekend: false,
    stations: [],
    lines: [],
    map,
  })

  assert.ok(journeys.length >= 32)
  assert.ok(journeys.every(journey => journey.accessMode === 'CITY'))
  assert.ok(journeys.every(journey => journey.landSafe))

  for (const journey of journeys) {
    for (const leg of journey.legs) {
      assert.ok(pathStaysOnLand(leg.from, leg.to, map))
    }
    for (let sample = 0; sample < 24; sample++) {
      const position = locateCitizen(journey, journey.totalDuration * sample / 24)
      assert.ok(map.isLand(position.x, position.y))
    }
  }
})

test('sends only citizens who live near a station toward it', () => {
  const map = getCityMap('SEOUL')
  const stationA = station('a', 44, 36, 'RESIDENTIAL')
  const stationB = station('b', 48, 36, 'COMMERCIAL')

  const journeys = createCitizenJourneys({
    seed: 7,
    waitingCount: 20,
    gameHour: 8,
    weekend: false,
    stations: [stationA, stationB],
    lines: [subwayLine([stationA, stationB])],
    map,
  })

  const stationBound = journeys.filter(journey => journey.accessMode !== 'CITY')
  assert.ok(stationBound.length > 0, '역세권 시민은 역으로 향해야 한다')
  assert.ok(
    stationBound.every(journey => journey.targetStationId === 'a' || journey.targetStationId === 'b'),
  )

  // 역으로 가는 사람은 모두 걸어갈 만한 거리에 살아야 한다 — 맵 반대편에서 걸어오지 않는다.
  for (const journey of stationBound) {
    const target = journey.targetStationId === 'a' ? stationA : stationB
    assert.ok(
      distance(journey.home, { x: target.posX, y: target.posY }) <= CITIZEN_WALK_RANGE,
      `${journey.id}이 ${CITIZEN_WALK_RANGE} 밖에서 역까지 걸어온다`,
    )
    for (const leg of journey.legs) {
      assert.ok(pathStaysOnLand(leg.from, leg.to, map))
    }
  }
})

test('keeps people living in districts that have no station at all', () => {
  const map = getCityMap('SEOUL')
  // 도심 한 곳에만 역이 있는 도시 — 나머지 동네도 비어 있으면 안 된다.
  const downtown = station('a', 44, 36, 'COMMERCIAL')
  const journeys = createCitizenJourneys({
    seed: 41,
    waitingCount: 120,
    gameHour: 9,
    weekend: false,
    stations: [downtown],
    lines: [subwayLine([downtown])],
    map,
  })

  const farFromStation = journeys.filter(
    journey => distance(journey.home, { x: downtown.posX, y: downtown.posY }) > CITIZEN_WALK_RANGE,
  )
  assert.ok(
    farFromStation.length >= journeys.length * 0.4,
    `역세권 밖 주민이 ${farFromStation.length}/${journeys.length}명뿐이다`,
  )
  // 역이 닿지 않는 주민은 역으로 몰리는 대신 동네에 남는다.
  assert.ok(farFromStation.every(journey => journey.accessMode === 'CITY'))
  for (const journey of farFromStation) {
    for (const leg of journey.legs) {
      assert.ok(pathStaysOnLand(leg.from, leg.to, map))
      assert.ok(distance(leg.to, journey.home) <= CITIZEN_ERRAND_RANGE + 0.001)
    }
  }

  // 집이 맵 한구석에 뭉치지 않고 도시 전역에 흩어져 있어야 한다.
  const homesX = journeys.map(journey => journey.home.x)
  const homesY = journeys.map(journey => journey.home.y)
  assert.ok(Math.max(...homesX) - Math.min(...homesX) >= 40)
  assert.ok(Math.max(...homesY) - Math.min(...homesY) >= 40)
})

test('starts and ends every journey at the same fixed home', () => {
  const map = getCityMap('BUSAN')
  const hub = station('a', 52, 58, 'COMMERCIAL')
  const world = {
    seed: 99,
    waitingCount: 60,
    gameHour: 8,
    weekend: false,
    stations: [hub],
    lines: [subwayLine([hub])],
    map,
  }

  let journeys = createCitizenJourneys(world)
  const homes = new Map(journeys.map(journey => [journey.id, journey.home]))

  // 여러 세대를 돌려도 사람은 살던 자리에서 나와 살던 자리로 돌아온다.
  for (let step = 1; step <= 40; step++) {
    journeys = advanceCitizenJourneys({
      ...world,
      previous: journeys,
      journeyTime: step * 4,
      maxRespawns: Infinity,
    })
    for (const journey of journeys) {
      assert.deepEqual(journey.home, homes.get(journey.id))
      assert.deepEqual(journey.legs[0].from, journey.home)
      if (journey.accessMode === 'CITY') {
        assert.deepEqual(journey.legs[journey.legs.length - 1].to, journey.home)
      }
    }
  }
})

test('does not teleport citizens that are already walking when a station is built', () => {
  const map = getCityMap('SEOUL')
  const stationA = station('a', 44, 36, 'RESIDENTIAL')
  const stationB = station('b', 48, 36, 'COMMERCIAL')
  const newStation = station('c', 30, 62, 'COMMERCIAL')
  const world = {
    seed: 7,
    waitingCount: 20,
    gameHour: 8,
    weekend: false,
    lines: [],
    map,
  }

  const before = createCitizenJourneys({ ...world, stations: [stationA, stationB] })
  const journeyTime = 3
  const positionsBefore = new Map(before.map(journey => [journey.id, locateCitizen(journey, journeyTime)]))

  // 역이 새로 생겨도 걷는 중인 시민의 여정은 그대로여야 한다.
  const after = advanceCitizenJourneys({
    ...world,
    stations: [stationA, stationB, newStation],
    previous: before,
    journeyTime,
  })

  let carriedOver = 0
  for (const journey of after) {
    const previous = before.find(item => item.id === journey.id)
    if (!previous || previous.generation !== journey.generation) continue
    carriedOver += 1
    assert.equal(journey.targetStationId, previous.targetStationId)
    assert.deepEqual(locateCitizen(journey, journeyTime), positionsBefore.get(journey.id))
  }
  // 새 역이 생겼다고 대부분의 시민이 리스폰되어서는 안 된다.
  assert.ok(carriedOver >= before.length * 0.8, `carried over ${carriedOver}/${before.length}`)
  assert.ok(after.every(journey => journey.targetStationId !== newStation.id || journey.generation > 0))
})

test('산·녹지에는 사람이 드물게 산다', () => {
  // 가중치는 HOME_IN_ZONE_SHARE(60%)에만 걸리고 나머지는 육지 전역 균등이라,
  // 녹지가 땅의 23%(서울)~38%(부산)를 차지하는 만큼 그대로 사람이 떨어지곤 했다.
  // 실제로 서울 녹지 밀도가 주거지와 거의 같았다(0.87 대 0.96).
  for (const key of ['SEOUL', 'BUSAN']) {
    const map = getCityMap(key)
    const homes: Array<{ x: number; y: number }> = []
    for (let seed = 1; seed <= 30; seed++) {
      for (const journey of createCitizenJourneys({
        seed: seed * 13, waitingCount: 400, gameHour: 9, weekend: false,
        stations: [], lines: [], map,
      })) homes.push(journey.home)
    }

    const kindAt = (x: number, y: number) =>
      map.districts.find(district => pointInDistrict(x, y, district))?.kind ?? null
    const greenHomes = homes.filter(home => kindAt(home.x, home.y) === 'GREEN').length

    // 녹지가 땅에서 차지하는 면적
    let land = 0
    let greenLand = 0
    for (let y = 0.25; y < 100; y += 0.5) for (let x = 0.25; x < 100; x += 0.5) {
      if (!map.isLand(x, y)) continue
      land++
      if (kindAt(x, y) === 'GREEN') greenLand++
    }

    const density = (greenHomes / homes.length) / (greenLand / land)
    // 면적 대비 인구 밀도. 1이면 「산이 동네만큼 붐빈다」는 뜻이다.
    assert.ok(density < 0.5, `${key} 녹지 인구밀도 ${density.toFixed(2)} — 산에 사람이 너무 많다`)
    // 0이면 산자락 동네가 통째로 사라진 것이다 — 부산은 실제로 비탈에 동네가 있다.
    assert.ok(density > 0.05, `${key} 녹지 인구밀도 ${density.toFixed(2)} — 산이 너무 비었다`)
  }
})
