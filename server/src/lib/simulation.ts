import { db } from './db'
import { evaluatePolicies } from './policy-engine'
import {
  MAX_MANAGEMENT_LEVEL,
  calculateTickEconomy,
  isFinalManagementGoalReached,
  isManagementGoalDeadlineMissed,
  resolveManagementGoal,
} from './economy'
import { advanceVehicleMotion, expressStopStationIds, headwayHoldFactors, stationDwellMinutes } from './vehicle-motion'
import { isVehicleInService } from './vehicle-service'
import { calcServiceScore } from './service-score'
import { SIM, dayIndexOfTick } from '@/types/game'
import { demandMultiplier, originWeight, destinationScore } from './demand-profile'
import type { SimResult, TickHighlight, StationSnapshot } from '@/types/game'
import type { Passenger, Vehicle, Station, Line, GameEvent } from '@prisma/client'

// ─── 결정론적 RNG (seeded) ───────────────────────────────────────────────

export function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

// ─── 메인 시뮬레이션 진입점 ──────────────────────────────────────────────

const citySimulationQueues = new Map<string, Promise<unknown>>()

export async function simulateTicks(cityId: string, count: number): Promise<SimResult> {
  return enqueueCitySimulation(cityId, () => simulateTicksUnlocked(cityId, count))
}

// 한 번의 syncCityClock 호출이 따라잡는 상한. HTTP 라이브 요청(/api/cities/[id])은
// 화면이 열려 있는 동안 한 요청이 수 초씩 막히면 안 되므로 기본값(3틱)을 그대로 쓰고,
// 실시간 WebSocket 브로드캐스트(scripts/realtime-server.ts)는 구독 중인 도시에만
// 적용되므로 더 큰 상한을 넘겨 호출한다 — 두 경우 모두 이 하나의 진입점을 공유한다.
const LIVE_POLL_MAX_TICKS = 3

export async function syncCityClock(cityId: string, maxTicks: number = LIVE_POLL_MAX_TICKS): Promise<SimResult | null> {
  return enqueueCitySimulation(cityId, async () => {
    const city = await db.city.findUnique({
      where: { id: cityId },
      select: { lastTickAt: true, status: true },
    })
    if (!city || city.status !== 'ACTIVE') return null

    const elapsedMs = Date.now() - city.lastTickAt.getTime()
    // 한 요청에서 너무 많이 따라잡으면 초기 로딩/폴링이 수 초씩 막힌다.
    // 나머지는 이후 폴링에서 조금씩 따라잡는다.
    const pendingTicks = Math.min(Math.floor(elapsedMs / SIM.LIVE_TICK_MS), maxTicks)
    if (pendingTicks < 1) return null
    return simulateTicksUnlocked(cityId, pendingTicks)
  })
}

// 동시에 락 트랜잭션(커넥션 1개)을 쥔 채로 실제 작업(커넥션 1개 이상)도 돌리므로,
// 도시 하나를 처리하는 데 최소 커넥션 2개가 필요하다. 풀 크기(10)를 넘겨 한꺼번에
// 돌리면 서로 커넥션을 기다리다 트랜잭션이 타임아웃난다 — 동시 처리 도시 수를 제한한다.
const HEARTBEAT_CONCURRENCY = 4
// 오래(수십 시간) 방치된 도시(개발 중 만들고 잊어버린 등)는 하트비트에서 제외한다.
// 그런 도시를 계속 붙잡고 있으면 워커 풀이 거기 묶여서, 최근에 접속했던(사람이
// 신경 쓸 가능성이 있는) 도시가 하트비트를 못 받고 굶는다.
const HEARTBEAT_STALE_CUTOFF_MS = 30 * 60 * 1000
// 배경 하트비트는 가볍게만 — 화면을 실제로 보고 있는 도시의 빠른 따라잡기는
// WebSocket 구독 쪽(scripts/realtime-server.ts, 더 큰 상한)이 맡는다.
const HEARTBEAT_MAX_TICKS = 3

// 아무도 관제실을 보고 있지 않아도(WS 구독이 없어도) 실시간에 가깝게 틱을 진행시켜,
// 나중에 들어왔을 때 밀린 만큼을 몰아서 따라잡을 필요가(그래서 순간이동처럼 보일
// 필요가) 없게 한다. scripts/realtime-server.ts가 주기적으로 호출한다.
export async function tickRecentlyActiveCities(excludeCityIds?: Set<string>): Promise<void> {
  const cities = await db.city.findMany({
    where: {
      status: 'ACTIVE',
      lastTickAt: { gt: new Date(Date.now() - HEARTBEAT_STALE_CUTOFF_MS) },
      // 라이브 엔진(live-city-engine.ts)이 이미 직접 틱을 굴리는 도시는 여기서 또
      // syncCityClock을 걸 필요가 없다 — lastTickAt이 항상 최신이라 no-op일 뿐인 헛수고다.
      ...(excludeCityIds && excludeCityIds.size > 0 ? { id: { notIn: [...excludeCityIds] } } : {}),
    },
    select: { id: true },
  })
  let cursor = 0
  async function worker() {
    while (cursor < cities.length) {
      const city = cities[cursor++]
      await syncCityClock(city.id, HEARTBEAT_MAX_TICKS).catch(err => {
        console.error(`[heartbeat] syncCityClock failed for ${city.id}`, err)
      })
    }
  }
  const workerCount = Math.min(HEARTBEAT_CONCURRENCY, cities.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
}

// 같은 도시를 동시에 시뮬레이션하면 틱이 두 번 처리되어 차량이
// 순간이동하거나 갑자기 빨라지는 것처럼 보일 수 있다. DB 어드바이저리 락으로
// 프로세스 경계를 넘어 도시 단위 상호 배제를 보장한다.
async function withCityLock<T>(cityId: string, task: () => Promise<T>): Promise<T> {
  return db.$transaction(
    async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${cityId})::bigint)`
      return task()
    },
    { timeout: 60_000, maxWait: 15_000 },
  )
}

/**
 * live-city-engine.ts가 DB flush 시 같은 도시의 다른 진입점(syncCityClock 등)과
 * 경합하지 않도록 재사용하는 진입점. 어드바이저리 락 + 인메모리 큐를 그대로 공유해서,
 * 라이브 엔진이 flush 중이어도 API 라우트의 syncCityClock 호출은 직렬화되어 안전하게
 * no-op(이미 lastTickAt이 최신이라 pendingTicks=0)이 된다.
 */
export function runCitySimulationExclusive<T>(cityId: string, task: () => Promise<T>): Promise<T> {
  return enqueueCitySimulation(cityId, task)
}

function enqueueCitySimulation<T>(cityId: string, task: () => Promise<T>): Promise<T> {
  const previous = citySimulationQueues.get(cityId) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(() => withCityLock(cityId, task))

  citySimulationQueues.set(cityId, next)

  return next.finally(() => {
    if (citySimulationQueues.get(cityId) === next) citySimulationQueues.delete(cityId)
  })
}

async function simulateTicksUnlocked(cityId: string, count: number): Promise<SimResult> {
  const city = await db.city.findUniqueOrThrow({
    where: { id: cityId },
    include: {
      lines: {
        include: {
          lineStations: { include: { station: true }, orderBy: { order: 'asc' } },
          vehicles: { orderBy: { id: 'asc' } },
          policies: { where: { isActive: true } },
        },
      },
      stations: true,
      events: { where: { status: { in: ['PENDING', 'ACTIVE'] } } },
    },
  })

  // 중간에 죽은 시뮬레이션으로 SimTick만 앞서 있으면 currentTick을 맞춰 재진입 500을 막는다.
  const latestTick = await db.simTick.findFirst({
    where: { cityId },
    orderBy: { tickNumber: 'desc' },
    select: { tickNumber: true },
  })
  let baseTick = city.currentTick
  if (latestTick && latestTick.tickNumber > baseTick) {
    baseTick = latestTick.tickNumber
    await db.city.update({
      where: { id: cityId },
      data: { currentTick: baseTick },
    })
  }

  // 노선 구성은 이 루프 안에서 바뀌지 않으므로 도달 가능 역은 한 번만 계산한다.
  const reachable = buildReachability(city.stations, city.lines)

  const rng = mulberry32(city.seed + baseTick)
  const highlights: TickHighlight[] = []
  let totalTransported = 0
  let totalArrived = 0
  let revenueEarned = 0
  let operatingCost = 0
  let peakCongestion = 0
  let ticksProcessed = 0
  let cashBalance = city.cashBalance
  let totalRevenue = city.totalRevenue
  let revenueGoal = city.revenueGoal
  const initialGoal = resolveManagementGoal(city.revenueGoal, city.goalReachedAtTick)
  let goalLevel = initialGoal.level
  let goalsCompleted = isFinalManagementGoalReached(city.revenueGoal, city.totalRevenue)
    ? MAX_MANAGEMENT_LEVEL
    : initialGoal.level - 1
  let happiness = city.happiness
  let score = city.score
  let insolvencyTicks = city.insolvencyTicks
  let unhappyTicks = city.unhappyTicks
  let goalReachedAtTick = city.goalReachedAtTick
  let gameOverReason: 'BANKRUPT' | 'HAPPINESS' | 'GOAL_DEADLINE' | null = null
  const allActionLogs: Awaited<ReturnType<typeof evaluatePolicies>> = []

  for (let i = 0; i < count; i++) {
    const tickNumber = baseTick + ticksProcessed + 1
    const gameTimeHour = (tickNumber / SIM.TICKS_PER_GAME_HOUR) % 24
    const dayIndex = dayIndexOfTick(tickNumber)
    // 시간대·요일별 수요 배율은 그 맵의 실제 지하철 승하차에서 뽑은 프로필이 준다.
    // 주말 곡선에 출퇴근 피크가 없는 것도, 부산이 서울보다 낮에 붐비는 것도 데이터가 그래서다.
    const demandMult = demandMultiplier(city.mapKey, gameTimeHour, dayIndex)

    // 마감일의 모든 틱이 끝난 뒤 다음 날로 넘어가는 순간 목표 실패를 확정한다.
    // 실패 판정 틱에서는 승객·차량·경제 상태를 더 진행하지 않는다.
    if (isManagementGoalDeadlineMissed({
      tickNumber,
      totalRevenue,
      revenueGoal,
      goalReachedAtTick,
    })) {
      gameOverReason = 'GOAL_DEADLINE'
      highlights.push({
        tickNumber,
        gameTimeHour,
        type: 'GOAL',
        description: `${goalLevel}단계 경영 목표를 기한 안에 달성하지 못해 경영이 종료되었습니다.`,
        severity: 'CRITICAL',
      })
      ticksProcessed += 1
      break
    }

    // 1. 사건 활성화
    const activeEvents = activateEvents(city.events, tickNumber)
    for (const event of activeEvents) {
      if (event.startsAtTick === tickNumber) {
        const station = city.stations.find(item => item.id === event.affectedStationId)
        highlights.push({
          tickNumber,
          gameTimeHour,
          type: 'EVENT',
          description: `${station?.name ?? '관광역'} 콘서트가 시작되어 승객 수요가 급증했습니다.`,
          severity: 'WARNING',
        })
      }
    }

    // 2. 현재 대기열을 반영해 승객 생성 (적체가 길수록 신규 수요가 줄어든다)
    const waitingBefore = await db.passenger.groupBy({
      by: ['originStationId'],
      where: { cityId, boardedAtTick: null },
      _count: { id: true },
    })
    const waitingByOrigin = new Map(waitingBefore.map(row => [row.originStationId, row._count.id]))
    const newPassengers = generatePassengers(
      city.stations,
      city.mapKey,
      tickNumber,
      gameTimeHour,
      dayIndex,
      demandMult,
      activeEvents,
      rng,
      waitingByOrigin,
      reachable,
    )
    if (newPassengers.length > 0) {
      await db.passenger.createMany({ data: newPassengers })
    }

    // 3. 역별 대기 승객 조회
    const stationSnapshots = await buildStationSnapshots(city.stations, cityId)

    // 4. 차량 이동 + 승하차
    // 승차 수는 예전과 같은 의미로 둔다(운임 = 태운 사람). 하차 수는 별도로 센다 —
    // 승객이 실제로 목적지에 닿았는지가 «구간이 제대로 도는가»의 지표다.
    const { boarded: transported, arrived } = await moveVehiclesAndBoard(city.lines, stationSnapshots, tickNumber)
    totalTransported += transported
    totalArrived += arrived

    // 5. AI 정책 평가 및 실행
    const serviceScore = calcServiceScore(stationSnapshots, city.lines)
    const economy = calculateTickEconomy({
      transported,
      serviceScore,
      cashBalance,
      totalRevenue,
      revenueGoal,
      happiness,
      score,
      insolvencyTicks,
      unhappyTicks,
      goalReachedAtTick,
      tickNumber,
      lines: city.lines,
    })
    revenueEarned += economy.revenue
    operatingCost += economy.operatingCost
    cashBalance = economy.cashBalance
    totalRevenue = economy.totalRevenue
    revenueGoal = economy.revenueGoal
    goalLevel = economy.goalLevel
    goalsCompleted = economy.goalsCompleted
    happiness = economy.happiness
    score = economy.score
    insolvencyTicks = economy.insolvencyTicks
    unhappyTicks = economy.unhappyTicks
    goalReachedAtTick = economy.goalReachedAtTick
    gameOverReason = economy.gameOverReason

    const tickRecord = await db.simTick.create({
      data: {
        cityId,
        tickNumber,
        gameTimeHour,
        passengersTransported: transported,
        avgCongestion: avgOf(stationSnapshots.map(s => s.congestion)),
        serviceScore,
        revenue: economy.revenue,
        operatingCost: economy.operatingCost,
        cashBalance,
        happiness,
        score,
      },
    })

    const policyActions = await evaluatePolicies(city.lines, stationSnapshots, tickRecord.id)
    allActionLogs.push(...policyActions)

    // 6. 혼잡 최고치 추적
    const maxCongestion = Math.max(...stationSnapshots.map(s => s.congestion))
    if (maxCongestion > peakCongestion) peakCongestion = maxCongestion

    // 7. 하이라이트 수집
    collectHighlights(highlights, stationSnapshots, policyActions, tickNumber, gameTimeHour)
    if (economy.goalReachedNow) {
      highlights.push({
        tickNumber,
        gameTimeHour,
        type: 'GOAL',
        description: economy.finalGoalReached
          ? `${economy.completedGoalLevel}단계 최종 경영 목표를 달성했습니다.`
          : `${economy.completedGoalLevel}단계 경영 목표를 달성해 지원금 ₵5,000을 받고 ${economy.goalLevel}단계 목표가 설정되었습니다.`,
        severity: 'INFO',
      })
    }

    ticksProcessed += 1
    if (gameOverReason) break
  }

  // 도시 틱 카운터 업데이트. 처리 시각을 현재로 덮지 않고 틱 길이만큼 전진시켜
  // 폴링 사이에 남은 실제 시간이 사라지지 않게 한다.
  const advancedClockMs = city.lastTickAt.getTime() + ticksProcessed * SIM.LIVE_TICK_MS
  const lastTickAt = new Date(Math.max(
    city.lastTickAt.getTime(),
    Math.min(Date.now(), advancedClockMs),
  ))
  await db.city.update({
    where: { id: cityId },
    data: {
      currentTick: baseTick + ticksProcessed,
      lastTickAt,
      cashBalance,
      totalRevenue,
      revenueGoal,
      happiness,
      score,
      insolvencyTicks,
      unhappyTicks,
      goalReachedAtTick,
      status: gameOverReason ? 'GAME_OVER' : city.status,
      gameOverReason,
    },
  })

  const lastTick = await db.simTick.findFirst({
    where: { cityId },
    orderBy: { tickNumber: 'desc' },
  })

  return {
    ticksProcessed,
    totalTransported,
    totalArrived,
    revenueEarned,
    operatingCost,
    peakCongestion,
    serviceScore: lastTick?.serviceScore ?? 100,
    cashBalance,
    happiness,
    score,
    goalReached: goalsCompleted > 0,
    gameOverReason,
    actionsFired: allActionLogs,
    highlights: highlights.slice(0, 3),
  }
}

// ─── 사건 활성화 ─────────────────────────────────────────────────────────

export function activateEvents(events: GameEvent[], tick: number): GameEvent[] {
  const active: GameEvent[] = []
  for (const ev of events) {
    if (ev.startsAtTick <= tick && tick < ev.startsAtTick + ev.durationTicks) {
      active.push(ev)
    }
  }
  return active
}

// ─── 승객 생성 ───────────────────────────────────────────────────────────

export function generatePassengers(
  stations: Station[],
  mapKey: string,
  tick: number,
  hour: number,
  dayIndex: number,
  demandMult: number,
  activeEvents: GameEvent[],
  rng: () => number,
  waitingByOrigin: Map<string, number>,
  reachable: Map<string, Station[]>,
): Array<{
  cityId: string; originStationId: string; destStationId: string
  type: 'COMMUTER' | 'TOURIST' | 'WORKER'; createdAtTick: number
}> {
  const passengers = []
  const eventStations = new Set(activeEvents.map(e => e.affectedStationId).filter(Boolean))

  for (const station of stations) {
    let rate = SIM.BASE_PASSENGER_RATE * originWeight(mapKey, station.type, hour, dayIndex)

    if (eventStations.has(station.id)) {
      const ev = activeEvents.find(e => e.affectedStationId === station.id)
      rate *= ev?.demandMultiplier ?? 1.5
    }

    // 역 용량 대비 대기가 아주 길 때만 유입을 줄여, 평소엔 사람이 잘 보이게 한다.
    const waiting = waitingByOrigin.get(station.id) ?? 0
    const capacity = Math.max(1, station.capacity)
    const congestion = Math.min(1, waiting / capacity)
    rate *= Math.max(0.4, 1 - congestion * 0.55)

    // 목적지 후보와 가중치는 출발역마다 다르다(거리가 들어가므로) — 역당 한 번만 만든다.
    const candidates = destinationCandidates(station, reachable, mapKey, hour, dayIndex)
    if (candidates.total <= 0) continue

    const count = Math.round(rate * (0.7 + rng() * 0.6))  // ±30% 랜덤
    for (let i = 0; i < count; i++) {
      const dest = pickDestination(candidates, rng)
      if (!dest) continue
      passengers.push({
        cityId: station.cityId,
        originStationId: station.id,
        destStationId: dest.id,
        type: pickPassengerType(station.type, demandMult, rng),
        createdAtTick: tick,
      })
    }
  }
  return passengers
}

type DestinationCandidates = { stations: Station[]; weights: number[]; total: number }

// 목적지 후보 = «그 역에서 지하철로 갈 수 있는 역». 갈 수 없는 곳을 목적지로 주면
// 승객이 영원히 승강장에 남아 혼잡도만 올린다. 노선이 아예 없는 역은 도시가 비어 보이지
// 않도록 예외로 전체 역을 쓴다(어차피 태울 차량도 없다).
function destinationCandidates(
  origin: Station,
  reachable: Map<string, Station[]>,
  mapKey: string,
  hour: number,
  dayIndex: number,
): DestinationCandidates {
  const pool = reachable.get(origin.id) ?? []
  const stations: Station[] = []
  const weights: number[] = []
  let total = 0
  for (const dest of pool) {
    if (dest.id === origin.id) continue
    const distance = Math.hypot(dest.posX - origin.posX, dest.posY - origin.posY)
    const weight = destinationScore(mapKey, origin.type, dest.type, hour, dayIndex, distance)
    if (weight <= 0) continue
    stations.push(dest)
    weights.push(weight)
    total += weight
  }
  return { stations, weights, total }
}

// 어느 역에서 어느 역으로 «한 번에» 갈 수 있는지. 같은 노선에 함께 실린 역끼리 이어 준다.
// 환승은 아직 모델에 없다(승객 경로 탐색이 없다) — 그래서 한 노선 안에서만 목적지를 고른다.
export function buildReachability(
  stations: Station[],
  lines: Array<{ status: string; lineStations: Array<{ station: Station }> }>,
): Map<string, Station[]> {
  const byStation = new Map<string, Map<string, Station>>()
  for (const line of lines) {
    if (line.status !== 'OPERATING') continue
    const onLine = line.lineStations.map(ls => ls.station)
    for (const station of onLine) {
      let set = byStation.get(station.id)
      if (!set) { set = new Map(); byStation.set(station.id, set) }
      for (const other of onLine) set.set(other.id, other)
    }
  }
  const result = new Map<string, Station[]>()
  for (const station of stations) {
    const set = byStation.get(station.id)
    // 노선에 안 실린 역은 갈 곳이 없다 — 도시가 비어 보이지 않게 전체를 후보로 둔다.
    result.set(station.id, set ? [...set.values()] : stations)
  }
  return result
}

// 미리 계산한 가중치로 목적지 추첨. 가중치에는 도착역 매력도 · 거리 감쇠 · 유형쌍 친화도가
// 모두 들어 있다(demand-profile.ts의 destinationScore).
function pickDestination(candidates: DestinationCandidates, rng: () => number): Station | null {
  if (candidates.total <= 0) return null
  let roll = rng() * candidates.total
  for (let i = 0; i < candidates.stations.length; i++) {
    roll -= candidates.weights[i]
    if (roll <= 0) return candidates.stations[i]
  }
  return candidates.stations[candidates.stations.length - 1] ?? null
}

function pickPassengerType(
  stationType: string,
  hourMult: number,
  rng: () => number,
): 'COMMUTER' | 'TOURIST' | 'WORKER' {
  if (stationType === 'TOURIST') return 'TOURIST'
  if (stationType === 'INDUSTRIAL') return rng() > 0.3 ? 'WORKER' : 'COMMUTER'
  return hourMult > 1.5 ? 'COMMUTER' : rng() > 0.5 ? 'COMMUTER' : 'TOURIST'
}

// ─── 역 스냅샷 구성 ──────────────────────────────────────────────────────

async function buildStationSnapshots(stations: Station[], cityId: string): Promise<StationSnapshot[]> {
  const waitingCounts = await db.passenger.groupBy({
    by: ['originStationId'],
    where: { cityId, boardedAtTick: null },
    _count: { id: true },
  })
  const countMap = new Map(waitingCounts.map(r => [r.originStationId, r._count.id]))

  const vehicleCounts = await db.vehicle.groupBy({
    by: ['currentStationId'],
    where: { line: { cityId }, status: 'OPERATING', isSpare: false },
    _count: { id: true },
  })
  const vehicleMap = new Map(vehicleCounts.map(r => [r.currentStationId!, r._count.id]))

  return stations.map(station => {
    const waiting = countMap.get(station.id) ?? 0
    const congestion = Math.min(waiting / station.capacity, 1.0)
    return {
      station,
      waitingCount: waiting,
      congestion,
      vehiclesPresent: vehicleMap.get(station.id) ?? 0,
    }
  })
}

// ─── 차량 이동 및 승하차 ─────────────────────────────────────────────────

// 노선의 station 배열에서 «지금 역보다 진행 방향 앞쪽»에 있는 역들. 승객은 이 안에
// 목적지가 있을 때만 탄다 — 반대편으로 실어 나르지 않게.
// 라이브 엔진(live-city-engine.ts)도 같은 규칙을 써야 해서 id만 요구한다.
export function stationsAhead(order: Array<{ id: string }>, fromId: string, direction: number): string[] {
  const at = order.findIndex(station => station.id === fromId)
  if (at < 0) return []
  const ahead = direction >= 0 ? order.slice(at + 1) : order.slice(0, at).reverse()
  return ahead.map(station => station.id)
}

async function moveVehiclesAndBoard(
  lines: Array<{ id: string; status: string; mode: string; lineStations: Array<{ station: Station; order: number }>; vehicles: Vehicle[] }>,
  snapshots: StationSnapshot[],
  tick: number,
): Promise<{ boarded: number; arrived: number }> {
  let boarded = 0
  let arrived = 0
  const snapshotMap = new Map(snapshots.map(s => [s.station.id, s]))

  for (const line of lines) {
    if (line.status !== 'OPERATING') continue
    const stationOrder = line.lineStations.map(ls => ls.station)
    if (stationOrder.length < 2) continue
    const expressStops = expressStopStationIds(stationOrder)

    const orderedVehicles = line.vehicles.slice().sort((a, b) => a.id.localeCompare(b.id))
    // 라이브 엔진과 같은 규칙 — 앞차와 붙은 차량을 늦춰 노선에 고르게 퍼뜨린다.
    const holdFactors = headwayHoldFactors(stationOrder, line.mode, orderedVehicles.filter(isVehicleInService))
    for (const vehicle of orderedVehicles) {
      if (!isVehicleInService(vehicle)) continue

      // 차고지 출고(음수 dwell > 기본 정차) 중에는 이번 틱에서 출고·정차만 소비하고
      // 바로 노선 주행으로 넘어가지 않게 한다. 대기→운행 재시작 시 차고지에서
      // 빠져나오는 연출이 한 틱에 통째로 스킵되지 않도록.
      const baseDwell = stationDwellMinutes(line.mode)
      const storedProgress = vehicle.segmentProgressMinutes || 0
      const hold = holdFactors.get(vehicle.id) ?? 1
      const stepMinutes = (storedProgress < -baseDwell
        ? Math.min(SIM.GAME_MINUTES_PER_TICK, -storedProgress)
        : SIM.GAME_MINUTES_PER_TICK) * hold

      const motion = advanceVehicleMotion(stationOrder, {
        currentStationId: vehicle.currentStationId ?? stationOrder[0].id,
        direction: vehicle.direction,
        segmentProgressMinutes: vehicle.segmentProgressMinutes,
      }, stepMinutes, line.mode, vehicle.isExpress ? expressStops : null)

      // 한 경제 틱 안에 도착한 모든 역에서 승하차를 처리한다.
      let onboard = motion.arrivedStationIds.length === 0 ? 0 : await db.passenger.count({
        where: { vehicleId: vehicle.id, arrivedAtTick: null },
      })

      for (const arrivedStationId of motion.arrivedStationIds) {
        // 1) 하차 먼저 — 자리를 비워야 그만큼 태울 수 있다.
        const alighting = await db.passenger.updateMany({
          where: { vehicleId: vehicle.id, destStationId: arrivedStationId, arrivedAtTick: null },
          data: { arrivedAtTick: tick, vehicleId: null },
        })
        onboard -= alighting.count
        arrived += alighting.count

        // 2) 승차 — 진행 방향 앞쪽에 목적지가 있는 승객만, 남은 자리만큼.
        //    방향은 이번 틱이 끝난 시점 기준이라 종점에서 되돌아선 경우 조금 보수적으로
        //    잡힌다(덜 태운다). 반대 방향으로 실어 나르는 것보다는 낫다.
        const room = vehicle.capacity - onboard
        const snap = snapshotMap.get(arrivedStationId)
        if (room <= 0 || !snap || snap.waitingCount <= 0) continue

        const ahead = stationsAhead(stationOrder, arrivedStationId, motion.direction)
        if (ahead.length === 0) continue

        const boardingPassengers = await db.passenger.findMany({
          where: {
            originStationId: arrivedStationId,
            boardedAtTick: null,
            destStationId: { in: ahead },
          },
          select: { id: true },
          orderBy: [{ createdAtTick: 'asc' }, { id: 'asc' }],
          take: room,
        })
        if (boardingPassengers.length === 0) continue

        await db.passenger.updateMany({
          where: { id: { in: boardingPassengers.map(passenger => passenger.id) } },
          data: { boardedAtTick: tick, vehicleId: vehicle.id },
        })
        onboard += boardingPassengers.length
        snap.waitingCount -= boardingPassengers.length
        snap.congestion = Math.min(snap.waitingCount / snap.station.capacity, 1)
        boarded += boardingPassengers.length
      }

      await db.vehicle.update({
        where: { id: vehicle.id },
        data: {
          currentStationId: motion.currentStationId,
          direction: motion.direction,
          segmentProgressMinutes: motion.segmentProgressMinutes,
        },
      })
      // 오프라인 복귀처럼 여러 틱을 한 번에 처리할 때 다음 반복이 방금 저장한
      // 구간 상태에서 계속 출발하도록 메모리 스냅샷도 함께 갱신한다.
      vehicle.currentStationId = motion.currentStationId
      vehicle.direction = motion.direction
      vehicle.segmentProgressMinutes = motion.segmentProgressMinutes
    }
  }
  return { boarded, arrived }
}

// ─── 하이라이트 수집 ─────────────────────────────────────────────────────

function collectHighlights(
  highlights: TickHighlight[],
  snapshots: StationSnapshot[],
  actions: { description: string; actionType: string }[],
  tick: number,
  hour: number,
) {
  const critical = snapshots.filter(s => s.congestion > 0.85)
  if (critical.length > 0) {
    highlights.push({
      tickNumber: tick,
      gameTimeHour: hour,
      type: 'CONGESTION',
      description: `${critical[0].station.name} 혼잡도 ${Math.round(critical[0].congestion * 100)}% 도달`,
      severity: critical[0].congestion > 0.95 ? 'CRITICAL' : 'WARNING',
    })
  }
  for (const action of actions) {
    highlights.push({
      tickNumber: tick,
      gameTimeHour: hour,
      type: 'AI_ACTION',
      description: action.description,
      severity: 'INFO',
    })
  }
}

// ─── 유틸 ────────────────────────────────────────────────────────────────

function avgOf(nums: number[]): number {
  if (nums.length === 0) return 0
  return nums.reduce((a, b) => a + b, 0) / nums.length
}
