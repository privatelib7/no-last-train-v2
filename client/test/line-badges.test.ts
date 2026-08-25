import assert from 'node:assert/strict'
import test from 'node:test'
import type { GameLine, Station } from '../src/api/game'
import { BADGE_MAX_DISTANCE, layoutLineEndBadges } from '../src/line-badges'

function station(id: string, posX: number, posY: number): Station {
  return { id, name: id, type: 'RESIDENTIAL', capacity: 200, posX, posY }
}

function line(id: string, name: string, stations: Station[]): GameLine {
  return {
    id,
    playerId: null,
    color: 'BLUE',
    mode: 'SUBWAY',
    name,
    status: 'OPERATING',
    depotX: stations[0]?.posX ?? 0,
    depotY: stations[0]?.posY ?? 0,
    lineStations: stations.map((item, order) => ({ stationId: item.id, order, station: item })),
    vehicles: [],
    policies: [],
  }
}

/** 종점이 같은 역인 노선을 count개 만든다 — 배지가 서로 밀어내야 하는 최악의 경우 */
function linesSharingTerminus(count: number) {
  const hub = station('hub', 50, 50)
  const stations = [hub]
  const lines: GameLine[] = []
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2
    const tail = station(`tail-${index}`, 50 + Math.cos(angle) * 12, 50 + Math.sin(angle) * 12)
    stations.push(tail)
    lines.push(line(`line-${index}`, `${index + 1}호선`, [tail, hub]))
  }
  return { lines, stations }
}

test('배지는 기본적으로 직전 역 → 종점 방향 바깥에 붙는다', () => {
  const a = station('a', 40, 50)
  const b = station('b', 50, 50)
  const badges = layoutLineEndBadges([line('l', '1호선', [a, b])], [a, b], 1)
  const tail = badges.find(badge => !badge.isHead)!
  assert.equal(tail.station.id, 'b')
  assert.ok(tail.x > b.posX, '종점 바깥(오른쪽)으로 나가야 한다')
  assert.ok(Math.abs(tail.y - b.posY) < 1e-6, '노선 방향을 벗어나지 않는다')

  const head = badges.find(badge => badge.isHead)!
  assert.ok(head.x < a.posX, '반대쪽 끝은 반대 방향으로 나간다')
})

test('노선 번호를 라벨로 쓴다', () => {
  const a = station('a', 40, 50)
  const b = station('b', 50, 50)
  const badges = layoutLineEndBadges([line('l', '3호선', [a, b])], [a, b], 1)
  assert.deepEqual(badges.map(badge => badge.label), ['3', '3'])
})

test('역이 하나뿐인 노선도 배지를 하나 붙인다 — 그것만이 다시 이을 손잡이다', () => {
  const a = station('a', 40, 50)
  const badges = layoutLineEndBadges([line('l', '1호선', [a])], [a], 1)
  assert.equal(badges.length, 1)
  assert.ok(badges[0].x < a.posX, '역 이름(위)·대기 승객 수(오른쪽)를 피해 왼쪽에 선다')
  assert.ok(Math.abs(badges[0].y - a.posY) < 1e-6, '위아래로는 치우치지 않는다')
})

test('역이 없는 노선은 배지를 만들지 않는다', () => {
  assert.deepEqual(layoutLineEndBadges([line('l', '1호선', [])], [], 1), [])
})

test('종점을 공유해도 배지가 노선에서 떨어져 나가지 않는다', () => {
  const { lines, stations } = linesSharingTerminus(5)
  for (const mapScale of [1, 0.5, 0.25]) {
    const badges = layoutLineEndBadges(lines, stations, mapScale)
    for (const badge of badges) {
      const distance = Math.hypot(badge.x - badge.station.posX, badge.y - badge.station.posY)
      assert.ok(
        distance <= BADGE_MAX_DISTANCE * mapScale + 1e-9,
        `배지가 종점에서 ${distance.toFixed(2)} 떨어졌다 (한도 ${(BADGE_MAX_DISTANCE * mapScale).toFixed(2)}, scale ${mapScale})`,
      )
    }
  }
})

test('종점을 공유하는 배지끼리 서로 포개지지 않는다', () => {
  const { lines, stations } = linesSharingTerminus(5)
  const badges = layoutLineEndBadges(lines, stations, 1)
  const atHub = badges.filter(badge => badge.station.id === 'hub')
  assert.equal(atHub.length, 5)
  for (let i = 0; i < atHub.length; i += 1) {
    for (let j = i + 1; j < atHub.length; j += 1) {
      const gap = Math.hypot(atHub[i].x - atHub[j].x, atHub[i].y - atHub[j].y)
      assert.ok(gap >= 3.3, `배지 ${atHub[i].id} · ${atHub[j].id} 가 ${gap.toFixed(2)}만큼만 떨어졌다`)
    }
  }
})

test('배지가 남의 역 글리프 위에 앉지 않는다', () => {
  // 종점 바로 바깥(기본 자리)에 다른 역이 있는 배치
  const a = station('a', 40, 50)
  const b = station('b', 50, 50)
  const blocker = station('blocker', 52.4, 50)
  const badges = layoutLineEndBadges([line('l', '1호선', [a, b])], [a, b, blocker], 1)
  const tail = badges.find(badge => !badge.isHead)!
  assert.ok(
    Math.hypot(tail.x - blocker.posX, tail.y - blocker.posY) >= 2.8,
    '막고 있는 역에서 비켜나야 한다',
  )
  assert.ok(
    Math.hypot(tail.x - b.posX, tail.y - b.posY) <= BADGE_MAX_DISTANCE + 1e-9,
    '비켜나더라도 자기 종점 곁에 남는다',
  )
})

test('종점이 줄줄이 가까운 도심 회랑에서도 배지가 제 노선 곁에 남는다', () => {
  // 예전 알고리즘은 앞 배지를 피해 진입 방향으로만 밀어내서, 다섯 번째 노선의
  // 배지가 자기 종점에서 18칸(지도 폭의 19%)이나 떨어져 나갔다.
  const stations: Station[] = []
  const lines: GameLine[] = []
  for (let index = 0; index < 5; index += 1) {
    const terminus = station(`t-${index}`, 50 + index * 3.2, 50)
    const prev = station(`p-${index}`, terminus.posX - 10, terminus.posY - 2)
    stations.push(prev, terminus)
    lines.push(line(`line-${index}`, `${index + 1}호선`, [prev, terminus]))
  }
  const badges = layoutLineEndBadges(lines, stations, 1)
  for (const badge of badges) {
    const distance = Math.hypot(badge.x - badge.station.posX, badge.y - badge.station.posY)
    assert.ok(
      distance <= BADGE_MAX_DISTANCE + 1e-9,
      `${badge.id} 배지가 종점에서 ${distance.toFixed(2)} 떨어졌다`,
    )
  }
})
