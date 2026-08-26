/**
 * 도시별 "라이브" 인메모리 시뮬레이션 엔진 — 실시간 WS 구독자가 있는 동안
 * server/scripts/realtime-server.ts가 도시마다 하나씩 소유한다.
 *
 * 기존 구조(simulation.ts)는 "경제 틱"(SimTick 1건 = 게임 10분)이 실시간 3초마다
 * 한 번씩 실행되며, 그때만 승객 탑승/매출이 DB에 확정된다. 반면 화면 좌표는
 * city-motion.ts가 마지막 DB 틱 이후 벽시계 경과로 최대 4틱(12초)까지 미리
 * 보간해서 보여준다 — 그래서 차량은 부드럽게 도착하는데 대기 승객 수/매출은
 * 최대 12초 늦게 반영되는 문제가 있었다.
 *
 * 이 파일은 그 간극을 없앤다: 차량 이동 + 도착 감지 + 탑승 + 매출 반영을
 * 100ms 프레임(advanceFrame)에서 인메모리로 즉시 확정하고, "경제 틱"이 하던
 * 나머지 일(승객 생성, 행복도/점수/목표 진행, AI 정책, SimTick 기록)은
 * 여전히 ~3초 주기로 실행하되 DB 대신 이 엔진의 메모리 상태를 읽고 쓴다.
 * DB에는 그 ~3초 주기로만 배치 반영한다(runEconomicTickAndFlush).
 *
 * 구독자가 없는 도시나 이 프로세스가 죽어있는 동안은 라이브 엔진이 없으므로
 * simulation.ts의 기존 DB 직결 경로(syncCityClock)가 그대로 동작한다 — 동작 변경 없음.
 */
import { randomUUID } from 'crypto'
import { db } from './db'
import type { Line, Vehicle, Station, Passenger, GameEvent, Policy, CityStatus } from '@prisma/client'
import {
  advanceVehicleMotion,
  expressStopStationIds,
  headwayHoldFactors,
  stationDwellMinutes,
  type MotionStation,
} from './vehicle-motion'
import { isVehicleInService } from './vehicle-service'
import { calcServiceScore } from './service-score'
import { calculateTickEconomy, ECONOMY, isManagementGoalDeadlineMissed } from './economy'
import { evaluatePolicies } from './policy-engine'
import {
  generatePassengers,
  mulberry32,
  activateEvents,
  runCitySimulationExclusive,
  buildReachability,
  stationsAhead,
} from './simulation'
import { demandMultiplier } from './demand-profile'
import {
  renderCityMotionSnapshot,
  publishMotionBase,
  setCachedMotionBase,
  type CityMotionBase,
  type CityMotionSnapshot,
} from './city-motion'
import { SIM, dayIndexOfTick, gameHourOfTick } from '@/types/game'
import type { StationSnapshot } from '@/types/game'

/** 한 프레임에서 소화하는 실시간 경과의 상한 — GC 정지 등으로 호출이 밀려도 차량이 순간이동하지 않게 막는다 */
const MAX_FRAME_DT_MS = 1000
/** 경제 틱 catch-up 루프가 한 번에 처리하는 상한 — 폭주 방지용 상한일 뿐, 평소엔 1회만 돈다 */
const MAX_ECONOMIC_TICKS_PER_FLUSH = 20
/** 엔진 시계가 벽시계보다 뒤처졌을 때 한 번의 flush에서 갚는 상한 — 한꺼번에 몰아 돌지 않게 한다 */
const MAX_CLOCK_CATCHUP_MS = SIM.LIVE_TICK_MS * 4

type EngineVehicle = Vehicle

type EngineLine = Line & {
  vehicles: EngineVehicle[]
  policies: Policy[]
  /** lineStations를 order대로 미리 펼쳐둔 좌표 — 매 프레임 재계산하지 않는다 */
  stations: MotionStation[]
}

type EnginePassenger = {
  id: string
  originStationId: string
  destStationId: string
  type: Passenger['type']
  createdAtTick: number
  boardedAtTick: number | null
  arrivedAtTick: number | null
  /** 타고 있는 차량 — 승차 시 채우고 목적지에서 내릴 때 비운다 */
  vehicleId: string | null
  /** 아직 한 번도 flush(=createMany)되지 않은, DB에 없는 승객인지 */
  isNew: boolean
}

export type LiveCityEngine = {
  cityId: string
  seed: number
  status: CityStatus
  gameOver: boolean
  gameOverReason: 'BANKRUPT' | 'HAPPINESS' | 'GOAL_DEADLINE' | null
  currentTick: number
  /** 마지막으로 확정된 경제 틱이 가리키는 벽시계(ms) — City.lastTickAt과 같은 의미 */
  lastTickAtMs: number
  /** 다음 프레임 dt 계산용 — 렌더/DB 의미의 lastTickAtMs와는 별개 */
  lastFrameAtMs: number
  /** 다음 경제 틱까지 누적된 실시간(ms) */
  economyClockAccumMs: number
  cashBalance: number
  /**
   * 이 엔진이 마지막으로 DB에서 읽거나 DB에 쓴 cashBalance. 역/노선 건설 같은 액션은
   * 별 프로세스(actions/route.ts)가 DB에 직접 비용을 차감한다 — 엔진에 알려주는 채널이
   * 없다. refreshLiveEngineTopology가 매 주기 DB의 cashBalance를 이 값과 비교해
   * «엔진이 모르는 사이에 바뀐 만큼»(외부 차감)만 골라 engine.cashBalance에 더해준다.
   * 그래야 화면(엔진 메모리 기반 liveCashBalance)에 건설비가 바로 반영되고, 다음
   * flush가 그 차감분을 없던 일로 덮어쓰지 않는다.
   */
  lastFlushedCashBalance: number
  totalRevenue: number
  revenueGoal: number
  happiness: number
  score: number
  insolvencyTicks: number
  unhappyTicks: number
  goalReachedAtTick: number | null
  lines: EngineLine[]
  stations: Station[]
  events: GameEvent[]
  /** 맵 종류 — 어느 도시의 실측 수요 곡선을 쓸지 (City.mapKey) */
  mapKey: string
  /** 역별로 «지하철로 갈 수 있는 역» — 목적지 후보. 노선 구성이 바뀌면 다시 만든다 */
  reachable: Map<string, Station[]>
  /** 역별 대기 승객 FIFO 큐 (createdAtTick 순서 유지) */
  waitQueues: Map<string, EnginePassenger[]>
  /** 차량별 탑승 중인 승객 — 목적지 역에서 내린다 */
  onboard: Map<string, EnginePassenger[]>
  /** 마지막 flush 이후 목적지에 도착한 기존 승객 id → 도착 틱 번호 */
  arrivedExisting: Map<string, number>
  /** 이번 경제 틱 동안(100ms 프레임들에서) 실제로 태운 인원 — calculateTickEconomy 입력용 */
  boardedSinceLastEconomicTick: number
  /** 마지막 flush 이후 위치가 바뀐 차량 id */
  dirtyVehicleIds: Set<string>
  /** 마지막 flush 이후 새로 생성된(아직 DB에 없는) 승객 */
  newPassengers: EnginePassenger[]
  /** 마지막 flush 이후 탑승 처리된 기존(DB에 이미 있던) 승객 id → 탑승 틱·차량 */
  boardedExisting: Map<string, { tick: number; vehicleId: string }>
  /**
   * 가장 최근 advanceFrame 호출에서 각 차량이 태운 인원수 — 매 프레임 시작 시 비우고
   * 그 프레임 동안의 탑승만 담는다. "방금 매출 발생" 클라이언트 팝업이 이 값을 그대로 쓴다.
   */
  justBoardedByVehicleId: Map<string, number>
}

/**
 * 구독자가 처음 생긴 도시를 위해 DB에서 상태를 읽어 라이브 엔진을 만든다.
 * simulation.ts의 다른 진입점(syncCityClock 등)과 같은 락 큐를 거쳐, 부트스트랩
 * 도중 동시에 들어온 API 틱 처리와 경합하지 않는다. 도시가 없거나 ACTIVE가 아니면 null.
 */
export async function createLiveCityEngine(cityId: string): Promise<LiveCityEngine | null> {
  return runCitySimulationExclusive(cityId, async () => {
    const city = await db.city.findUnique({
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
    if (!city || city.status !== 'ACTIVE') return null

    // 중간에 죽은 시뮬레이션으로 SimTick만 앞서 있으면 currentTick을 맞춘다 (simulation.ts와 동일 로직).
    const latestTick = await db.simTick.findFirst({
      where: { cityId },
      orderBy: { tickNumber: 'desc' },
      select: { tickNumber: true },
    })
    let baseTick = city.currentTick
    if (latestTick && latestTick.tickNumber > baseTick) {
      baseTick = latestTick.tickNumber
      await db.city.update({ where: { id: cityId }, data: { currentTick: baseTick } })
    }

    const toEngine = (p: Passenger): EnginePassenger => ({
      id: p.id,
      originStationId: p.originStationId,
      destStationId: p.destStationId,
      type: p.type,
      createdAtTick: p.createdAtTick,
      boardedAtTick: p.boardedAtTick,
      arrivedAtTick: p.arrivedAtTick,
      vehicleId: p.vehicleId,
      isNew: false,
    })

    const waitingPassengers = await db.passenger.findMany({
      where: { cityId, boardedAtTick: null },
      orderBy: [{ createdAtTick: 'asc' }, { id: 'asc' }],
    })
    const waitQueues = new Map<string, EnginePassenger[]>()
    for (const p of waitingPassengers) {
      const queue = waitQueues.get(p.originStationId) ?? []
      queue.push(toEngine(p))
      waitQueues.set(p.originStationId, queue)
    }

    // 이미 차에 타 있던 승객도 실어 온다 — 안 그러면 구독이 끊길 때마다 «영원히 못 내리는»
    // 승객이 DB에 쌓인다.
    const ridingPassengers = await db.passenger.findMany({
      where: { cityId, arrivedAtTick: null, vehicleId: { not: null } },
      orderBy: [{ createdAtTick: 'asc' }, { id: 'asc' }],
    })
    const onboard = new Map<string, EnginePassenger[]>()
    for (const p of ridingPassengers) {
      const list = onboard.get(p.vehicleId!) ?? []
      list.push(toEngine(p))
      onboard.set(p.vehicleId!, list)
    }

    const lines: EngineLine[] = city.lines.map(line => ({
      ...line,
      vehicles: line.vehicles,
      policies: line.policies,
      stations: line.lineStations.map(ls => ({
        id: ls.station.id,
        posX: ls.station.posX,
        posY: ls.station.posY,
      })),
    }))

    const now = Date.now()
    const engine: LiveCityEngine = {
      cityId,
      seed: city.seed,
      status: city.status,
      gameOver: false,
      gameOverReason: null,
      currentTick: baseTick,
      lastTickAtMs: city.lastTickAt.getTime(),
      lastFrameAtMs: now,
      economyClockAccumMs: 0,
      cashBalance: city.cashBalance,
      lastFlushedCashBalance: city.cashBalance,
      totalRevenue: city.totalRevenue,
      revenueGoal: city.revenueGoal,
      happiness: city.happiness,
      score: city.score,
      insolvencyTicks: city.insolvencyTicks,
      unhappyTicks: city.unhappyTicks,
      goalReachedAtTick: city.goalReachedAtTick,
      lines,
      stations: city.stations,
      events: city.events,
      mapKey: city.mapKey,
      reachable: buildReachability(city.stations, city.lines),
      waitQueues,
      onboard,
      arrivedExisting: new Map(),
      boardedSinceLastEconomicTick: 0,
      dirtyVehicleIds: new Set(),
      newPassengers: [],
      boardedExisting: new Map(),
      justBoardedByVehicleId: new Map(),
    }
    return engine
  })
}

function absorbExternalCash(engine: LiveCityEngine, dbCash: number): void {
  const externalDelta = dbCash - engine.lastFlushedCashBalance
  if (externalDelta === 0) return
  engine.cashBalance += externalDelta
  engine.lastFlushedCashBalance = dbCash
}

/**
 * 노선 건설/역 건설/차량 배차 같은 액션은 server/src/app/api/cities/[id]/actions/route.ts가
 * DB에 직접 쓴다(라이브 엔진과 별 프로세스라 알림 채널이 없다). 그래서 엔진이 주기적으로
 * DB 구조(노선·역·차량 목록)를 다시 읽어 반영해야, 방금 만든 노선에 방금 투입한 차량이
 * 새로고침 없이 바로 움직인다. 이미 엔진이 굴리고 있던 차량의 위치(currentStationId/
 * direction/segmentProgressMinutes)는 DB보다 최신이므로 그대로 지키되, 다음 두 경우엔
 * DB 값을 그대로 채택한다:
 *   1. 그 노선의 역 구성이 바뀐 경우(INSERT_STATION) — 액션 라우트가 트랜잭션 안에서
 *      이미 reconcileVehicleForInsertedStation으로 차량 위치를 새 구간 기준으로 보정해뒀다.
 *   2. 그 차량의 운행 상태(status/isSpare)가 바뀐 경우(방금 배차/입고) — vehicleServiceUpdate가
 *      새로 지정한 출발 위치를 엔진이 그대로 받아야 그 즉시 움직인다.
 */
export async function refreshLiveEngineTopology(engine: LiveCityEngine): Promise<void> {
  if (engine.status !== 'ACTIVE' || engine.gameOver) return

  await runCitySimulationExclusive(engine.cityId, async () => {
    const city = await db.city.findUnique({
      where: { id: engine.cityId },
      include: {
        lines: {
          include: {
            lineStations: { include: { station: true }, orderBy: { order: 'asc' } },
            vehicles: { orderBy: { id: 'asc' } },
            policies: { where: { isActive: true } },
          },
        },
        stations: true,
      },
    })
    if (!city) return

    absorbExternalCash(engine, city.cashBalance)
    engine.stations = city.stations

    const existingLinesById = new Map(engine.lines.map(l => [l.id, l]))
    const nextLines: EngineLine[] = city.lines.map(dbLine => {
      const dbStations: MotionStation[] = dbLine.lineStations.map(ls => ({
        id: ls.station.id,
        posX: ls.station.posX,
        posY: ls.station.posY,
      }))
      const existing = existingLinesById.get(dbLine.id)

      if (!existing) {
        // 새로 만든 노선 — DB 그대로 채택한다.
        return { ...dbLine, vehicles: dbLine.vehicles, policies: dbLine.policies, stations: dbStations }
      }

      const topologyChanged = existing.stations.length !== dbStations.length
        || existing.stations.some((s, i) => s.id !== dbStations[i]?.id)

      const existingVehiclesById = new Map(existing.vehicles.map(v => [v.id, v]))
      const nextVehicles: EngineVehicle[] = dbLine.vehicles.map(dbVehicle => {
        const engineVehicle = existingVehiclesById.get(dbVehicle.id)
        if (!engineVehicle) return dbVehicle // 새로 산 차량

        const serviceChanged = engineVehicle.status !== dbVehicle.status
          || engineVehicle.isSpare !== dbVehicle.isSpare
        if (topologyChanged || serviceChanged) return dbVehicle

        // 그 외엔 엔진이 이미 갖고 있는(최대 ~400ms 이내) 더 최신 위치를 지키고,
        // 정원 등 엔진이 직접 건드리지 않는 필드만 DB 최신값으로 맞춘다.
        return {
          ...dbVehicle,
          currentStationId: engineVehicle.currentStationId,
          direction: engineVehicle.direction,
          segmentProgressMinutes: engineVehicle.segmentProgressMinutes,
        }
      })

      return { ...dbLine, vehicles: nextVehicles, policies: dbLine.policies, stations: dbStations }
    })

    engine.lines = nextLines
    // 노선을 새로 짓거나 연장하면 «갈 수 있는 역»이 달라진다. 같이 갱신하지 않으면
    // 새로 이어진 역이 목적지 후보에 영영 안 들어온다.
    engine.reachable = buildReachability(city.stations, city.lines)
  })
}

// simulation.ts의 moveVehiclesAndBoard와 같은 규칙을 메모리 상태로 수행한다.
// 두 경로(라이브 구독 / DB 따라잡기)가 어긋나면 화면과 저장된 결과가 달라진다.
function alightAndBoardAtStation(
  engine: LiveCityEngine,
  stationId: string,
  vehicle: EngineVehicle,
  line: EngineLine,
  direction: number,
): void {
  // 지금 누적 중인(아직 확정 안 된) 경제 틱 번호로 찍는다 — flush 시 이 틱이 확정된다.
  const tickNumber = engine.currentTick + 1
  const riding = engine.onboard.get(vehicle.id) ?? []

  // 1) 하차 먼저 — 자리를 비워야 그만큼 태울 수 있다.
  const staying: EnginePassenger[] = []
  for (const p of riding) {
    if (p.destStationId === stationId) {
      p.arrivedAtTick = tickNumber
      p.vehicleId = null
      if (!p.isNew) engine.arrivedExisting.set(p.id, tickNumber)
    } else {
      staying.push(p)
    }
  }

  // 2) 승차 — 진행 방향 앞쪽에 목적지가 있는 승객만, 남은 자리만큼.
  const room = vehicle.capacity - staying.length
  const queue = engine.waitQueues.get(stationId)
  if (room > 0 && queue && queue.length > 0) {
    const ahead = new Set(stationsAhead(line.stations, stationId, direction))
    if (ahead.size > 0) {
      const boarded: EnginePassenger[] = []
      const remaining: EnginePassenger[] = []
      for (const p of queue) {
        // FIFO를 지키되(먼저 온 사람이 먼저 탄다) 방향이 안 맞으면 다음 차를 기다린다.
        if (boarded.length < room && ahead.has(p.destStationId)) boarded.push(p)
        else remaining.push(p)
      }
      if (boarded.length > 0) {
        engine.waitQueues.set(stationId, remaining)
        for (const p of boarded) {
          p.boardedAtTick = tickNumber
          p.vehicleId = vehicle.id
          if (!p.isNew) engine.boardedExisting.set(p.id, { tick: tickNumber, vehicleId: vehicle.id })
          staying.push(p)
        }
        engine.boardedSinceLastEconomicTick += boarded.length
        engine.justBoardedByVehicleId.set(
          vehicle.id,
          (engine.justBoardedByVehicleId.get(vehicle.id) ?? 0) + boarded.length,
        )
      }
    }
  }

  if (staying.length > 0) engine.onboard.set(vehicle.id, staying)
  else engine.onboard.delete(vehicle.id)
}

/**
 * 100ms(또는 실제 경과 dtMs)만큼 차량을 연속으로 전진시키고, 역에 도착하면
 * 그 자리에서 즉시(메모리) 탑승 처리한다. DB 호출 없음 — 매 프레임 호출해도 안전하다.
 */
export function advanceFrame(engine: LiveCityEngine, now: number): void {
  const rawDt = now - engine.lastFrameAtMs
  engine.lastFrameAtMs = now
  // 이번 프레임의 탑승만 담아야 하므로, 이전 프레임 값을 렌더가 이미 읽어갔든 아니든 비운다.
  engine.justBoardedByVehicleId.clear()
  if (engine.status !== 'ACTIVE' || engine.gameOver) return
  const dtMs = Math.max(0, Math.min(rawDt, MAX_FRAME_DT_MS))
  if (dtMs <= 0) return

  const elapsedGameMinutes = dtMs * (SIM.GAME_MINUTES_PER_TICK / SIM.LIVE_TICK_MS)
  engine.economyClockAccumMs += dtMs

  for (const line of engine.lines) {
    if (line.status !== 'OPERATING') continue
    if (line.stations.length < 2) continue
    const expressStops = expressStopStationIds(line.stations)
    // 앞차와 너무 붙은 차량만 조금씩 늦춰 노선 전체에 고르게 퍼지게 한다
    const holdFactors = headwayHoldFactors(line.stations, line.mode, line.vehicles.filter(isVehicleInService))

    for (const vehicle of line.vehicles) {
      if (!isVehicleInService(vehicle)) continue

      const baseDwell = stationDwellMinutes(line.mode)
      const storedProgress = vehicle.segmentProgressMinutes || 0
      const hold = holdFactors.get(vehicle.id) ?? 1
      const stepMinutes = (storedProgress < -baseDwell
        ? Math.min(elapsedGameMinutes, -storedProgress)
        : elapsedGameMinutes) * hold
      if (stepMinutes <= 0) continue

      const motion = advanceVehicleMotion(line.stations, {
        currentStationId: vehicle.currentStationId ?? line.stations[0].id,
        direction: vehicle.direction,
        segmentProgressMinutes: vehicle.segmentProgressMinutes,
      }, stepMinutes, line.mode, vehicle.isExpress ? expressStops : null)

      for (const stationId of motion.arrivedStationIds) {
        alightAndBoardAtStation(engine, stationId, vehicle, line, motion.direction)
      }

      vehicle.currentStationId = motion.currentStationId
      vehicle.direction = motion.direction
      vehicle.segmentProgressMinutes = motion.segmentProgressMinutes
      engine.dirtyVehicleIds.add(vehicle.id)
    }
  }
}

function avgOf(nums: number[]): number {
  if (nums.length === 0) return 0
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

function buildStationSnapshots(engine: LiveCityEngine): StationSnapshot[] {
  return engine.stations.map(station => {
    const waiting = engine.waitQueues.get(station.id)?.length ?? 0
    return {
      station,
      waitingCount: waiting,
      congestion: Math.min(waiting / station.capacity, 1),
      vehiclesPresent: 0,
    }
  })
}

/** simulation.ts의 경제 틱 한 번 분량(승객 생성 → 경제 계산 → 정책 평가 → SimTick 기록)을 메모리 상태로 수행한다 */
async function runSingleEconomicTick(engine: LiveCityEngine): Promise<void> {
  const tickNumber = engine.currentTick + 1
  const gameTimeHour = gameHourOfTick(tickNumber)
  const dayIndex = dayIndexOfTick(tickNumber)
  // 시간대·요일 배율은 그 맵의 실측 승하차에서 뽑은 프로필이 준다 (simulation.ts와 같은 값).
  const demandMult = demandMultiplier(engine.mapKey, gameTimeHour, dayIndex)

  if (isManagementGoalDeadlineMissed({
    tickNumber,
    totalRevenue: engine.totalRevenue,
    revenueGoal: engine.revenueGoal,
    goalReachedAtTick: engine.goalReachedAtTick,
  })) {
    engine.gameOver = true
    engine.gameOverReason = 'GOAL_DEADLINE'
    engine.currentTick = tickNumber
    engine.lastTickAtMs += SIM.LIVE_TICK_MS
    return
  }

  engine.events = await db.gameEvent.findMany({
    where: { cityId: engine.cityId, status: { in: ['PENDING', 'ACTIVE'] } },
  })
  const activeEvents = activateEvents(engine.events, tickNumber)

  const waitingByOrigin = new Map<string, number>()
  for (const [stationId, queue] of engine.waitQueues) waitingByOrigin.set(stationId, queue.length)

  const rng = mulberry32(engine.seed + tickNumber)
  const generated = generatePassengers(
    engine.stations, engine.mapKey, tickNumber, gameTimeHour, dayIndex,
    demandMult, activeEvents, rng, waitingByOrigin, engine.reachable,
  )
  for (const p of generated) {
    const passenger: EnginePassenger = {
      id: randomUUID(),
      originStationId: p.originStationId,
      destStationId: p.destStationId,
      type: p.type,
      createdAtTick: p.createdAtTick,
      boardedAtTick: null,
      arrivedAtTick: null,
      vehicleId: null,
      isNew: true,
    }
    const queue = engine.waitQueues.get(p.originStationId)
    if (queue) queue.push(passenger)
    else engine.waitQueues.set(p.originStationId, [passenger])
    engine.newPassengers.push(passenger)
  }

  const stationSnapshots = buildStationSnapshots(engine)

  const transported = engine.boardedSinceLastEconomicTick
  engine.boardedSinceLastEconomicTick = 0

  const serviceScore = calcServiceScore(
    stationSnapshots,
    engine.lines.map(line => ({
      status: line.status,
      lineStations: line.stations.map(s => ({ stationId: s.id })),
      vehicles: line.vehicles,
    })),
  )

  const economy = calculateTickEconomy({
    transported,
    serviceScore,
    cashBalance: engine.cashBalance,
    totalRevenue: engine.totalRevenue,
    revenueGoal: engine.revenueGoal,
    happiness: engine.happiness,
    score: engine.score,
    insolvencyTicks: engine.insolvencyTicks,
    unhappyTicks: engine.unhappyTicks,
    goalReachedAtTick: engine.goalReachedAtTick,
    tickNumber,
    lines: engine.lines,
  })

  engine.cashBalance = economy.cashBalance
  engine.totalRevenue = economy.totalRevenue
  engine.revenueGoal = economy.revenueGoal
  engine.happiness = economy.happiness
  engine.score = economy.score
  engine.insolvencyTicks = economy.insolvencyTicks
  engine.unhappyTicks = economy.unhappyTicks
  engine.goalReachedAtTick = economy.goalReachedAtTick
  engine.currentTick = tickNumber
  engine.lastTickAtMs += SIM.LIVE_TICK_MS

  const tickRecord = await db.simTick.create({
    data: {
      cityId: engine.cityId,
      tickNumber,
      gameTimeHour,
      passengersTransported: transported,
      avgCongestion: avgOf(stationSnapshots.map(s => s.congestion)),
      serviceScore,
      revenue: economy.revenue,
      operatingCost: economy.operatingCost,
      cashBalance: economy.cashBalance,
      happiness: economy.happiness,
      score: economy.score,
    },
  })

  await evaluatePolicies(engine.lines, stationSnapshots, tickRecord.id)

  if (economy.gameOverReason) {
    engine.gameOver = true
    engine.gameOverReason = economy.gameOverReason
  }
}

async function flushToDb(engine: LiveCityEngine): Promise<void> {
  const dirtyVehicles = [...engine.dirtyVehicleIds]
  engine.dirtyVehicleIds.clear()
  if (dirtyVehicles.length > 0) {
    const vehicleById = new Map<string, EngineVehicle>()
    for (const line of engine.lines) for (const v of line.vehicles) vehicleById.set(v.id, v)
    await Promise.all(dirtyVehicles.map(id => {
      const v = vehicleById.get(id)
      if (!v) return Promise.resolve()
      return db.vehicle.update({
        where: { id },
        data: {
          currentStationId: v.currentStationId,
          direction: v.direction,
          segmentProgressMinutes: v.segmentProgressMinutes,
        },
      })
    }))
  }

  if (engine.newPassengers.length > 0) {
    const toCreate = engine.newPassengers.map(p => ({
      id: p.id,
      cityId: engine.cityId,
      originStationId: p.originStationId,
      destStationId: p.destStationId,
      type: p.type,
      createdAtTick: p.createdAtTick,
      boardedAtTick: p.boardedAtTick,
      arrivedAtTick: p.arrivedAtTick,
      vehicleId: p.vehicleId,
    }))
    engine.newPassengers = []
    await db.passenger.createMany({ data: toCreate })
    // 방금 만든 승객은 이제 DB에 있으므로, 이후 탑승·하차는 *Existing 경로로 잡혀야 한다.
    for (const queue of engine.waitQueues.values()) {
      for (const p of queue) if (p.isNew) p.isNew = false
    }
    for (const riding of engine.onboard.values()) {
      for (const p of riding) if (p.isNew) p.isNew = false
    }
  }

  if (engine.boardedExisting.size > 0) {
    // 같은 (틱, 차량)끼리 묶어 updateMany 횟수를 줄인다.
    const groups = new Map<string, { tick: number; vehicleId: string; ids: string[] }>()
    for (const [id, { tick, vehicleId }] of engine.boardedExisting) {
      const key = `${tick}|${vehicleId}`
      const group = groups.get(key) ?? { tick, vehicleId, ids: [] }
      group.ids.push(id)
      groups.set(key, group)
    }
    engine.boardedExisting.clear()
    await Promise.all([...groups.values()].map(({ tick, vehicleId, ids }) =>
      db.passenger.updateMany({ where: { id: { in: ids } }, data: { boardedAtTick: tick, vehicleId } }),
    ))
  }

  if (engine.arrivedExisting.size > 0) {
    const byTick = new Map<number, string[]>()
    for (const [id, tick] of engine.arrivedExisting) {
      const list = byTick.get(tick) ?? []
      list.push(id)
      byTick.set(tick, list)
    }
    engine.arrivedExisting.clear()
    await Promise.all([...byTick.entries()].map(([tick, ids]) =>
      db.passenger.updateMany({ where: { id: { in: ids } }, data: { arrivedAtTick: tick, vehicleId: null } }),
    ))
  }

  // db.city.update보다 먼저 외부(공사비) 차감을 흡수한다. 안 그러면 엔진 메모리
  // 잔고가 API가 방금 깎은 DB 값을 덮어 공사비가 되살아난다.
  const cityCash = await db.city.findUnique({
    where: { id: engine.cityId },
    select: { cashBalance: true },
  })
  if (cityCash) absorbExternalCash(engine, cityCash.cashBalance)

  const flushedCashBalance = engine.cashBalance
  await db.city.update({
    where: { id: engine.cityId },
    data: {
      currentTick: engine.currentTick,
      lastTickAt: new Date(engine.lastTickAtMs),
      cashBalance: flushedCashBalance,
      totalRevenue: engine.totalRevenue,
      revenueGoal: engine.revenueGoal,
      happiness: engine.happiness,
      score: engine.score,
      insolvencyTicks: engine.insolvencyTicks,
      unhappyTicks: engine.unhappyTicks,
      goalReachedAtTick: engine.goalReachedAtTick,
      status: engine.gameOver ? 'GAME_OVER' : engine.status,
      gameOverReason: engine.gameOverReason,
    },
  })
  engine.lastFlushedCashBalance = flushedCashBalance
  if (engine.gameOver) engine.status = 'GAME_OVER'
}

/**
 * 이 엔진이 아닌 다른 경로(API 라우트의 syncCityClock 등)가 도시를 먼저 진행시켰으면
 * 그 틱 번호를 받아들인다. 그러지 않으면 이미 존재하는 tickNumber로 SimTick을 만들려다
 * 유니크 충돌이 나고, 그 주기의 flush가 통째로 건너뛰어진다.
 *
 * 잔고·행복도까지 합치지는 않는다 — 두 경로가 각자 시뮬레이션한 경제 상태를 섞을 방법이
 * 없어서, 여기서는 엔진의 인메모리 상태를 진실로 두고 다음 flush에서 덮어쓴다.
 */
async function adoptCityClockIfAdvanced(engine: LiveCityEngine): Promise<void> {
  const city = await db.city.findUnique({
    where: { id: engine.cityId },
    select: { currentTick: true, lastTickAt: true },
  })
  if (!city || city.currentTick <= engine.currentTick) return
  engine.currentTick = city.currentTick
  engine.lastTickAtMs = Math.max(engine.lastTickAtMs, city.lastTickAt.getTime())
}

/** syncEngineClockToWallTime이 건드리는 부분만 — 테스트에서 엔진 전체를 만들지 않아도 되게 한다 */
export type EngineClock = Pick<LiveCityEngine, 'lastTickAtMs' | 'economyClockAccumMs'>

/**
 * 엔진 시계(lastTickAtMs + 아직 틱으로 소비되지 않은 누적분)를 벽시계에 맞춘다.
 *
 * 뒤처지는 쪽: 부팅할 때 이미 밀려 있던 lastTickAt을 그대로 물려받고, advanceFrame은
 * MAX_FRAME_DT_MS 상한 탓에 프레임이 늦은 만큼을 덜 쌓는다. 이 적자를 방치하면 DB의
 * lastTickAt이 계속 밀린 채로 남고, 그러면 API 프로세스의 syncCityClock이 "이 도시는
 * 밀렸다"고 보고 같은 도시를 이중으로 틱한다 — SimTick의 (cityId, tickNumber) 유니크
 * 충돌이 그 결과다. 조금씩 갚아 두면 syncCityClock이 설계대로 no-op이 된다.
 *
 * 앞서는 쪽: 락을 오래 기다리면 그 사이에도 advanceFrame이 누적분을 계속 늘리므로,
 * 실제 흐른 시간보다 많이 쌓일 수 있다. 그대로 두면 게임 시계가 앞질러 가므로 깎아낸다.
 *
 * 반드시 «락을 잡은 뒤에» 부른다 — 락 밖에서 미리 맞추면 락 대기 시간만큼 다시 쌓여
 * 이중으로 더해진다.
 */
export function syncEngineClockToWallTime(engine: EngineClock, now: number = Date.now()): void {
  const driftMs = now - (engine.lastTickAtMs + engine.economyClockAccumMs)
  engine.economyClockAccumMs = driftMs >= 0
    ? engine.economyClockAccumMs + Math.min(driftMs, MAX_CLOCK_CATCHUP_MS)
    : Math.max(0, engine.economyClockAccumMs + driftMs)
}

/**
 * ~SIM.LIVE_TICK_MS(3초) 주기로 realtime-server.ts가 호출한다. 누적된 경제 틱을
 * (보통 1개) 처리하고 곧바로 DB에 배치 flush한다 — 락은 이 전체를 한 번만 감싼다.
 */
export async function runEconomicTickAndFlush(engine: LiveCityEngine): Promise<void> {
  if (engine.status !== 'ACTIVE' || engine.gameOver) return
  // 락을 괜히 잡지 않도록 싸게 먼저 거른다. 누적분이 아직 모자라도 벽시계 기준으로 밀려
  // 있으면(위 syncEngineClockToWallTime의 적자) 들어가서 맞춰야 한다.
  if (
    engine.economyClockAccumMs < SIM.LIVE_TICK_MS
    && Date.now() - engine.lastTickAtMs < SIM.LIVE_TICK_MS
  ) return

  await runCitySimulationExclusive(engine.cityId, async () => {
    await adoptCityClockIfAdvanced(engine)
    syncEngineClockToWallTime(engine)
    let guard = 0
    while (
      engine.economyClockAccumMs >= SIM.LIVE_TICK_MS
      && !engine.gameOver
      && guard < MAX_ECONOMIC_TICKS_PER_FLUSH
    ) {
      guard += 1
      engine.economyClockAccumMs -= SIM.LIVE_TICK_MS
      await runSingleEconomicTick(engine)
    }
    await flushToDb(engine)
  })
}

/** 구독자가 모두 빠져나가 엔진을 폐기하기 전, 누적된 변경분을 마지막으로 DB에 반영한다 */
export async function flushLiveCityEngine(engine: LiveCityEngine): Promise<void> {
  await runCitySimulationExclusive(engine.cityId, () => flushToDb(engine))
}

function toCityMotionBase(engine: LiveCityEngine, now: number): CityMotionBase {
  return {
    cityId: engine.cityId,
    status: engine.status,
    currentTick: engine.currentTick,
    // 렌더 시점을 "지금"으로 둬서 city-motion.ts의 벽시계 미리보기 보간이 0이 되게 한다 —
    // 엔진이 이미 advanceFrame으로 "지금" 시점까지 권위 있는 위치를 갱신했으므로 더 이상
    // 프리뷰로 앞서갈 필요가 없다(그 프리뷰가 원래 버그의 원인이었다).
    lastTickAtMs: now,
    stationStats: engine.stations.map(s => ({
      stationId: s.id,
      waitingCount: engine.waitQueues.get(s.id)?.length ?? 0,
    })),
    loadedAt: now,
    lines: engine.lines.map(line => ({
      id: line.id,
      mode: line.mode,
      status: line.status,
      depotX: line.depotX,
      depotY: line.depotY,
      stations: line.stations,
      vehicles: line.vehicles.map(v => ({
        id: v.id,
        status: v.status,
        isSpare: v.isSpare,
        currentStationId: v.currentStationId,
        direction: v.direction,
        segmentProgressMinutes: v.segmentProgressMinutes,
        isExpress: v.isExpress,
      })),
    })),
  }
}

/**
 * 엔진의 현재 상태를 클라이언트로 보낼 스냅샷으로 렌더한다. 기존 city-motion.ts의
 * renderCityMotionSnapshot을 그대로 재사용해 정차/차고지 출고/예비차량 등 렌더 분기를
 * 중복 구현하지 않는다. cashBalance/totalRevenue는 이번 경제 틱에서 지금까지 탄
 * 인원의 운임을 얹어 "화면용"으로 즉시 보여준다 — 진짜 원장은 여전히 경제 틱에서만 확정된다.
 */
export function renderLiveMotionSnapshot(engine: LiveCityEngine, now: number): CityMotionSnapshot {
  const base = toCityMotionBase(engine, now)
  const snapshot = renderCityMotionSnapshot(base, now)
  const liveRevenue = engine.boardedSinceLastEconomicTick * ECONOMY.FARE_PER_PASSENGER
  return {
    ...snapshot,
    liveCashBalance: engine.cashBalance + liveRevenue,
    liveTotalRevenue: engine.totalRevenue + liveRevenue,
    vehicles: snapshot.vehicles.map(v => ({
      ...v,
      justBoarded: engine.justBoardedByVehicleId.get(v.id) ?? 0,
      onboardCount: engine.onboard.get(v.id)?.length ?? 0,
    })),
  }
}

/**
 * 이 프로세스 자신의 REST 폴백 경로(buildCityMotionSnapshot)가 참고하는 로컬 캐시를
 * 갱신한다. 순수 메모리 쓰기라 100ms 프레임마다 불러도 부담이 없다.
 */
export function warmLocalMotionCache(engine: LiveCityEngine, now: number): void {
  setCachedMotionBase(toCityMotionBase(engine, now))
}

/**
 * 다른 realtime-server 인스턴스가 참고할 수 있게 Redis에도 채워둔다(단일 인스턴스
 * 배포에서는 필수는 아니지만 기존 city-motion.ts의 캐시 관례를 그대로 따른다).
 * Redis 왕복이 있으니 100ms 프레임이 아니라 경제 틱(~3초) 주기로만 호출한다.
 */
export function publishLiveMotionBase(engine: LiveCityEngine, now: number): void {
  publishMotionBase(toCityMotionBase(engine, now))
}
