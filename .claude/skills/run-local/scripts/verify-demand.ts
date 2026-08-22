// 로그인 없이 시뮬레이션을 검증한다.
//
// 게임의 서울 맵과 같은 구성(8역·2노선·차량)으로 임시 도시를 만들어 하루치(144틱)를
// «실제 DB»로 돌리고, 아래를 확인한 뒤 지운다. 사용자의 기존 도시는 건드리지 않는다.
//
//   1) 시간대별 승객 생성이 공공데이터 곡선을 따르는가
//   2) 승객이 실제로 목적지에 «도착»하는가 (태우기만 하고 못 내려 주면 0이 나온다)
//   3) 통행거리 분포가 실측(평균 7.0km)과 비슷한가
//   4) 어느 «구간»이 붐비는가
//
//   cd server && npx tsx --env-file-if-exists=.env ../.claude/skills/run-local/scripts/verify-demand.ts
//
// 다른 것을 재고 싶으면 집계 부분만 바꾼다 — 도시 생성·정리 골격은 그대로 쓸 수 있다.
import { db } from '@/lib/db'
import { simulateTicks } from '@/lib/simulation'
import { demandMultiplier, mapDistanceToKm, OD_MODEL } from '@/lib/demand-profile'
import { SIM } from '@/types/game'
import { stationDwellMinutes } from '@/lib/vehicle-motion'

const TICKS_PER_DAY = SIM.TICKS_PER_GAME_HOUR * 24

// 게임 시드(prisma/seed.ts)의 서울 구성과 같은 모양
const STATIONS = [
  { name: '서울역', type: 'HUB', capacity: 240, posX: 44, posY: 36 },
  { name: '시청역', type: 'COMMERCIAL', capacity: 200, posX: 43, posY: 29 },
  { name: '홍대입구역', type: 'TOURIST', capacity: 180, posX: 24, posY: 38 },
  { name: '영등포역', type: 'RESIDENTIAL', capacity: 180, posX: 22, posY: 60 },
  { name: '강남역', type: 'COMMERCIAL', capacity: 200, posX: 60, posY: 64 },
  { name: '잠실역', type: 'TOURIST', capacity: 180, posX: 78, posY: 58 },
  { name: '청량리역', type: 'INDUSTRIAL', capacity: 190, posX: 66, posY: 28 },
  { name: '노원역', type: 'RESIDENTIAL', capacity: 180, posX: 70, posY: 14 },
] as const
const LINES = [
  { color: 'RED', name: '1호선', depotX: 71, depotY: 9, stations: ['노원역', '청량리역', '시청역', '서울역', '영등포역'] },
  { color: 'BLUE', name: '2호선', depotX: 82, depotY: 56, stations: ['홍대입구역', '시청역', '강남역', '잠실역'] },
] as const

async function buildCity(mapKey: string) {
  const city = await db.city.create({
    data: { name: `__verify_${mapKey}`, mapKey, seed: 42, lastTickAt: new Date(0) },
  })
  const byName = new Map<string, { id: string; posX: number; posY: number }>()
  for (const st of STATIONS) {
    const created = await db.station.create({ data: { ...st, cityId: city.id } })
    byName.set(st.name, created)
  }
  for (const line of LINES) {
    const created = await db.line.create({
      data: { cityId: city.id, color: line.color as never, name: line.name, status: 'OPERATING', depotX: line.depotX, depotY: line.depotY },
    })
    const ids = line.stations.map(n => byName.get(n)!.id)
    await db.lineStation.createMany({ data: ids.map((stationId, order) => ({ lineId: created.id, stationId, order })) })
    // 배차를 촘촘히 넣어 하루 안에 충분히 실어 나르게 한다
    await db.vehicle.createMany({
      data: [0, 1, 2].map(i => ({
        lineId: created.id, capacity: 120, status: 'OPERATING' as const,
        currentStationId: ids[i % ids.length], headwayMinutes: 3,
        segmentProgressMinutes: -stationDwellMinutes('SUBWAY'),
      })),
    })
  }
  return { city, byName }
}

const f = (v: number) => v.toFixed(1).padStart(5)

async function run(mapKey: string) {
  const { city, byName } = await buildCity(mapKey)
  const result = await simulateTicks(city.id, TICKS_PER_DAY)

  const rows = await db.passenger.findMany({
    where: { cityId: city.id },
    select: {
      createdAtTick: true, boardedAtTick: true, arrivedAtTick: true, destStationId: true,
      originStation: { select: { id: true, name: true, type: true, posX: true, posY: true } },
    },
  })
  const pos = new Map([...byName].map(([name, s]) => [s.id, { name, posX: s.posX, posY: s.posY }]))

  // 1) 시간대 곡선
  const byHour = new Array(24).fill(0)
  for (const r of rows) byHour[Math.floor((r.createdAtTick / SIM.TICKS_PER_GAME_HOUR) % 24)] += 1
  const mean = byHour.reduce((a, b) => a + b, 0) / 24

  // 3) 통행거리
  let kmSum = 0
  const kmList: number[] = []
  for (const r of rows) {
    const d = pos.get(r.destStationId)
    if (!d) continue
    const km = mapDistanceToKm(Math.hypot(d.posX - r.originStation.posX, d.posY - r.originStation.posY))
    kmSum += km
    kmList.push(km)
  }
  kmList.sort((a, b) => a - b)

  // 4) 구간 부하 — 도착한 승객의 출발·도착역 쌍
  const legs = new Map<string, number>()
  for (const r of rows) {
    if (r.arrivedAtTick === null) continue
    const d = pos.get(r.destStationId)
    if (!d) continue
    const key = `${r.originStation.name} → ${d.name}`
    legs.set(key, (legs.get(key) ?? 0) + 1)
  }

  await db.city.delete({ where: { id: city.id } })

  console.log(`\n=== ${mapKey} · 하루 ===`)
  console.log(`생성 ${rows.length}명 · 승차 ${result.totalTransported}명 · 도착 ${result.totalArrived}명`)
  console.log('시각      ', Array.from({ length: 24 }, (_, h) => String(h).padStart(5)).join(''))
  console.log('실제 생성 ', byHour.map(v => f(v / mean)).join(''))
  console.log('프로필    ', Array.from({ length: 24 }, (_, h) => f(demandMultiplier(mapKey, h, 0))).join(''))
  console.log(`통행거리  평균 ${(kmSum / kmList.length).toFixed(1)}km · 중앙 ${kmList[Math.floor(kmList.length / 2)].toFixed(1)}km`
    + `  (실측 서울 평균 ${OD_MODEL.tripKm.mean}km · 중앙 ${OD_MODEL.tripKm.median}km)`)
  console.log('붐비는 구간 상위 6개 (실제 도착 기준)')
  for (const [leg, n] of [...legs].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`  ${leg.padEnd(24)} ${n}명`)
  }
}

async function main() {
  for (const mapKey of ['SEOUL', 'BUSAN']) await run(mapKey)
  await db.$disconnect()
}

main().catch(err => { console.error(err); process.exit(1) })
