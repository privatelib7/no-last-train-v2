import assert from 'node:assert/strict'
import test from 'node:test'
import { buildReachability } from './simulation'
import type { Station } from '@prisma/client'

const station = (id: string, type = 'RESIDENTIAL'): Station =>
  ({ id, name: id, type, capacity: 100, posX: 0, posY: 0, cityId: 'c' } as unknown as Station)

const line = (status: string, stations: Station[]) =>
  ({ status, lineStations: stations.map(s => ({ station: s })) })

test('같은 노선의 역끼리만 목적지가 된다 — 환승 모델이 아직 없어서다', () => {
  const a = station('a'); const b = station('b'); const c = station('c'); const d = station('d')
  const reach = buildReachability([a, b, c, d], [line('OPERATING', [a, b, c])])

  assert.deepEqual(reach.get('a')!.map(s => s.id).sort(), ['a', 'b', 'c'])
  assert.ok(!reach.get('a')!.some(s => s.id === 'd'), 'd는 노선 밖이라 목적지가 아니다')
})

test('환승역은 두 노선의 역을 모두 목적지로 가진다', () => {
  const a = station('a'); const hub = station('hub'); const c = station('c')
  const reach = buildReachability([a, hub, c], [
    line('OPERATING', [a, hub]),
    line('OPERATING', [hub, c]),
  ])

  assert.deepEqual(reach.get('hub')!.map(s => s.id).sort(), ['a', 'c', 'hub'])
  // 환승 없이 한 번에 갈 수 없으므로 a에서 c는 후보가 아니다
  assert.ok(!reach.get('a')!.some(s => s.id === 'c'))
})

test('운행하지 않는 노선은 목적지를 만들지 않는다', () => {
  const a = station('a'); const b = station('b')
  const reach = buildReachability([a, b], [line('SUSPENDED', [a, b])])
  // 노선이 없는 역과 같은 취급 — 도시가 비어 보이지 않게 전체 역이 후보가 된다
  assert.deepEqual(reach.get('a')!.map(s => s.id).sort(), ['a', 'b'])
})

test('노선에 실리지 않은 역도 후보가 비지 않는다 — 승강장이 텅 비지 않게', () => {
  const a = station('a'); const b = station('b'); const lonely = station('lonely')
  const reach = buildReachability([a, b, lonely], [line('OPERATING', [a, b])])
  assert.ok(reach.get('lonely')!.length > 0)
})
