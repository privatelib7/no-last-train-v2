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
} from './simulation'
import {
  renderCityMotionSnapshot,
  publishMotionBase,
  setCachedMotionBase,
  type CityMotionBase,
  type CityMotionSnapshot,
} from './city-motion'
import { SIM, TIME_DEMAND_MULTIPLIER, periodOfHour, isWeekendTick } from '@/types/game'
import type { StationSnapshot } from '@/types/game'

/** 한 프레임에서 소화하는 실시간 경과의 상한 — GC 정지 등으로 호출이 밀려도 차량이 순간이동하지 않게 막는다 */
const MAX_FRAME_DT_MS = 1000
/** 경제 틱 catch-up 루프가 한 번에 처리하는 상한 — 폭주 방지용 상한일 뿐, 평소엔 1회만 돈다 */
const MAX_ECONOMIC_TICKS_PER_FLUSH = 20

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
  /** 역별 대기 승객 FIFO 큐 (createdAtTick 순서 유지) */
  waitQueues: Map<string, EnginePassenger[]>
  /** 이번 경제 틱 동안(100ms 프레임들에서) 실제로 태운 인원 — calculateTickEconomy 입력용 */
  boardedSinceLastEconomicTick: number
  /** 마지막 flush 이후 위치가 바뀐 차량 id */
  dirtyVehicleIds: Set<string>
  /** 마지막 flush 이후 새로 생성된(아직 DB에 없는) 승객 */
  newPassengers: EnginePassenger[]
  /** 마지막 flush 이후 탑승 처리된 기존(DB에 이미 있던) 승객 id → 탑승 틱 번호 */
  boardedExisting: Map<string, number>
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

    const waitingPassengers = await db.passenger.findMany({
      where: { cityId, boardedAtTick: null },
      orderBy: [{ createdAtTick: 'asc' }, { id: 'asc' }],
    })
    const waitQueues = new Map<string, EnginePassenger[]>()
    for (const p of waitingPassengers) {
      const queue = waitQueues.get(p.originStationId) ?? []
      queue.push({
        id: p.id,
        originStationId: p.originStationId,
        destStationId: p.destStationId,
        type: p.type,
        createdAtTick: p.createdAtTick,
        boardedAtTick: null,
        isNew: false,
      })
      waitQueues.set(p.originStationId, queue)
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
      waitQueues,
      boardedSinceLastEconomicTick: 0,
      dirtyVehicleIds: new Set(),
      newPassengers: [],
      boardedExisting: new Map(),
      justBoardedByVehicleId: new Map(),
    }
    return engine
  })
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
  })
}

function boardAtStation(engine: LiveCityEngine, stationId: string, vehicle: EngineVehicle): void {
  const queue = engine.waitQueues.get(stationId)
  if (!queue || queue.length === 0) return
  const boarding = Math.min(queue.length, vehicle.capacity)
  if (boarding <= 0) return
  const boarded = queue.splice(0, boarding)
  // 지금 누적 중인(아직 확정 안 된) 경제 틱 번호로 찍는다 — flush 시 이 틱이 확정된다.
  const tickNumber = engine.currentTick + 1
  for (const p of boarded) {
    p.boardedAtTick = tickNumber
    if (!p.isNew) engine.boardedExisting.set(p.id, tickNumber)
  }
  engine.boardedSinceLastEconomicTick += boarded.length
  engine.justBoardedByVehicleId.set(
    vehicle.id,
    (engine.justBoardedByVehicleId.get(vehicle.id) ?? 0) + boarded.length,
  )
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

    for (const vehicle of line.vehicles) {
      if (!isVehicleInService(vehicle)) continue

      const baseDwell = stationDwellMinutes(line.mode)
      const storedProgress = vehicle.segmentProgressMinutes || 0
      const stepMinutes = storedProgress < -baseDwell
        ? Math.min(elapsedGameMinutes, -storedProgress)
        : elapsedGameMinutes
      if (stepMinutes <= 0) continue

      const motion = advanceVehicleMotion(line.stations, {
        currentStationId: vehicle.currentStationId ?? line.stations[0].id,
        direction: vehicle.direction,
        segmentProgressMinutes: vehicle.segmentProgressMinutes,
      }, stepMinutes, line.mode)

      for (const stationId of motion.arrivedStationIds) {
        boardAtStation(engine, stationId, vehicle)
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
  const gameTimeHour = (tickNumber / SIM.TICKS_PER_GAME_HOUR) % 24
  const weekend = isWeekendTick(tickNumber)
  const period = periodOfHour(gameTimeHour)
  const baseDemand = TIME_DEMAND_MULTIPLIER[Math.floor(gameTimeHour)] ?? 1.0
  const demandMult = weekend ? Math.min(baseDemand, 1.3) : baseDemand

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
    engine.stations, tickNumber, demandMult, period, weekend, activeEvents, rng, waitingByOrigin,
  )
  for (const p of generated) {
    const passenger: EnginePassenger = {
      id: randomUUID(),
      originStationId: p.originStationId,
      destStationId: p.destStationId,
      type: p.type,
      createdAtTick: p.createdAtTick,
      boardedAtTick: null,
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
    }))
    engine.newPassengers = []
    await db.passenger.createMany({ data: toCreate })
    // 방금 만든 승객은 이제 DB에 있으므로, 이후 탑승은 boardedExisting 경로로 잡혀야 한다.
    for (const queue of engine.waitQueues.values()) {
      for (const p of queue) if (p.isNew) p.isNew = false
    }
  }

  if (engine.boardedExisting.size > 0) {
    const byTick = new Map<number, string[]>()
    for (const [id, tick] of engine.boardedExisting) {
      const list = byTick.get(tick) ?? []
      list.push(id)
      byTick.set(tick, list)
    }
    engine.boardedExisting.clear()
    await Promise.all([...byTick.entries()].map(([tick, ids]) =>
      db.passenger.updateMany({ where: { id: { in: ids } }, data: { boardedAtTick: tick } }),
    ))
  }

  await db.city.update({
    where: { id: engine.cityId },
    data: {
      currentTick: engine.currentTick,
      lastTickAt: new Date(engine.lastTickAtMs),
      cashBalance: engine.cashBalance,
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
  if (engine.gameOver) engine.status = 'GAME_OVER'
}

/**
 * ~SIM.LIVE_TICK_MS(3초) 주기로 realtime-server.ts가 호출한다. 누적된 경제 틱을
 * (보통 1개) 처리하고 곧바로 DB에 배치 flush한다 — 락은 이 전체를 한 번만 감싼다.
 */
export async function runEconomicTickAndFlush(engine: LiveCityEngine): Promise<void> {
  if (engine.status !== 'ACTIVE' || engine.gameOver) return
  if (engine.economyClockAccumMs < SIM.LIVE_TICK_MS) return

  await runCitySimulationExclusive(engine.cityId, async () => {
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
