type TransitMode = 'SUBWAY' | 'BUS' | string

export type MotionStation = {
  id: string
  posX: number
  posY: number
}

export type VehicleMotionState = {
  currentStationId: string | null
  direction: number
  segmentProgressMinutes: number
}

/**
 * 급행 정차역 집합 — 한 칸씩 건너뛰어 2개 역마다 정차한다. 노선을 따라 역 하나씩
 * 지나가는 이동 자체(advanceVehicleMotion의 인접역 순회)는 완행과 똑같이 유지하고,
 * 이 집합에 없는 역은 "정차하지 않고 통과"만 시킨다 — 그래서 A에서 C로 건너뛸 때도
 * 실제로는 B 위치를 그대로 지나가며 이동하지, B를 건너뛰고 순간이동하지 않는다.
 * 마지막 역은 짝이 안 맞아도 항상 포함해 종점을 건너뛰지 않게 한다.
 */
export function expressStopStationIds(stations: MotionStation[]): Set<string> {
  const ids = new Set<string>()
  for (let i = 0; i < stations.length; i += 2) ids.add(stations[i].id)
  if (stations.length > 0) ids.add(stations[stations.length - 1].id)
  return ids
}

export type VehicleMotion = {
  currentStationId: string | null
  nextStationId: string | null
  direction: number
  segmentProgressMinutes: number
  dwellRemainingMinutes: number
  isDwelling: boolean
  segmentDurationMinutes: number
  progress: number
  x: number | null
  y: number | null
  arrivedStationIds: string[]
}

const MODE_SPEED: Record<'SUBWAY' | 'BUS', number> = {
  SUBWAY: 1.05,
  BUS: 0.72,
}

const MODE_DURATION_LIMITS: Record<'SUBWAY' | 'BUS', { min: number; max: number }> = {
  SUBWAY: { min: 4, max: 28 },
  BUS: { min: 5.5, max: 35 },
}

const MODE_DWELL_MINUTES: Record<'SUBWAY' | 'BUS', number> = {
  SUBWAY: 1.5,
  BUS: 2.5,
}

/** 운행 시작 시 차고지(depot) → 종점 출고에 쓰는 게임 분 */
const MODE_DEPOT_PULLOUT_MINUTES: Record<'SUBWAY' | 'BUS', number> = {
  SUBWAY: 1.2,
  BUS: 1.8,
}

/** 클라이언트가 서버와 동일한 속도로 보간하도록 motion API로 내려주는 물리 상수 */
export type TransitMotionPhysics = {
  speed: Record<'SUBWAY' | 'BUS', number>
  durationLimits: Record<'SUBWAY' | 'BUS', { min: number; max: number }>
  dwellMinutes: Record<'SUBWAY' | 'BUS', number>
  depotPulloutMinutes: Record<'SUBWAY' | 'BUS', number>
}

export function getTransitMotionPhysics(): TransitMotionPhysics {
  return {
    speed: { ...MODE_SPEED },
    durationLimits: {
      SUBWAY: { ...MODE_DURATION_LIMITS.SUBWAY },
      BUS: { ...MODE_DURATION_LIMITS.BUS },
    },
    dwellMinutes: { ...MODE_DWELL_MINUTES },
    depotPulloutMinutes: { ...MODE_DEPOT_PULLOUT_MINUTES },
  }
}

function normalizedMode(mode: TransitMode): 'SUBWAY' | 'BUS' {
  return mode === 'BUS' ? 'BUS' : 'SUBWAY'
}

export function stationDwellMinutes(mode: TransitMode): number {
  return MODE_DWELL_MINUTES[normalizedMode(mode)]
}

export function depotPulloutMinutes(mode: TransitMode): number {
  return MODE_DEPOT_PULLOUT_MINUTES[normalizedMode(mode)]
}

/**
 * 지도상 거리와 교통수단 속도로 역간 게임 소요시간을 계산한다.
 * min/max로 클램프하면 프론트엔드 보간 구간 길이가 실제 거리와 어긋나면서
 * 차량이 순간이동하듯 띄엄띄엄 움직이는 문제가 있어 클램프 없이 실거리 기준 시간을 그대로 쓴다.
 * 0.5분 단위로 반올림해 짧은 도심 구간과 긴 외곽 구간이 서로 다른 시간을 갖는다.
 */
export function segmentTravelMinutes(from: MotionStation, to: MotionStation, mode: TransitMode): number {
  const transitMode = normalizedMode(mode)
  const distance = Math.hypot(to.posX - from.posX, to.posY - from.posY)
  const rawMinutes = distance / MODE_SPEED[transitMode]
  return Math.round(rawMinutes * 2) / 2
}

function nextStation(
  stations: MotionStation[],
  currentIndex: number,
  currentDirection: number,
) {
  let direction = currentDirection >= 0 ? 1 : -1
  let nextIndex = currentIndex + direction
  if (nextIndex < 0 || nextIndex >= stations.length) {
    direction *= -1
    nextIndex = currentIndex + direction
  }
  return { direction, nextIndex }
}

/**
 * 저장된 구간 진행 상태에서 임의의 게임 분만큼 전진한다.
 * 한 번의 경제 틱 안에서 여러 역을 통과할 수 있고, 역간 이동은 틱 경계와 무관하다.
 *
 * stopStationIds를 주면(급행) 그 집합에 없는 역은 도착해도 정차(dwellRemainingMinutes)하지
 * 않고 arrivedStationIds에도 넣지 않은 채 바로 다음 구간으로 넘어간다 — 인접역을
 * 하나씩 지나가는 이동 자체는 완행과 동일하고, "정차 여부"만 달라진다.
 */
export function advanceVehicleMotion(
  stations: MotionStation[],
  state: VehicleMotionState,
  elapsedGameMinutes: number,
  mode: TransitMode,
  stopStationIds?: Set<string> | null,
): VehicleMotion {
  if (stations.length === 0 || !state.currentStationId) {
    return {
      currentStationId: state.currentStationId,
      nextStationId: null,
      direction: state.direction >= 0 ? 1 : -1,
      segmentProgressMinutes: 0,
      dwellRemainingMinutes: 0,
      isDwelling: false,
      segmentDurationMinutes: 0,
      progress: 0,
      x: null,
      y: null,
      arrivedStationIds: [],
    }
  }

  let currentIndex = stations.findIndex(station => station.id === state.currentStationId)
  if (currentIndex < 0) currentIndex = 0
  let direction = state.direction >= 0 ? 1 : -1
  const storedProgressMinutes = state.segmentProgressMinutes || 0
  let dwellRemainingMinutes = storedProgressMinutes < 0 ? -storedProgressMinutes : 0
  let segmentProgressMinutes = Math.max(0, storedProgressMinutes)
  let remainingMinutes = Math.max(0, elapsedGameMinutes)
  const arrivedStationIds: string[] = []

  if (stations.length === 1) {
    const station = stations[currentIndex]
    return {
      currentStationId: station.id,
      nextStationId: null,
      direction,
      segmentProgressMinutes: 0,
      dwellRemainingMinutes: 0,
      isDwelling: false,
      segmentDurationMinutes: 0,
      progress: 0,
      x: station.posX,
      y: station.posY,
      arrivedStationIds,
    }
  }

  // 비정상적으로 큰 오프라인 전진에도 무한 루프가 생기지 않도록 충분한 상한을 둔다.
  let guard = 0
  while (remainingMinutes > 0 && guard < 10_000) {
    guard += 1
    if (dwellRemainingMinutes > 0) {
      if (remainingMinutes < dwellRemainingMinutes) {
        dwellRemainingMinutes -= remainingMinutes
        remainingMinutes = 0
        break
      }
      remainingMinutes -= dwellRemainingMinutes
      dwellRemainingMinutes = 0
      if (remainingMinutes === 0) break
    }

    const next = nextStation(stations, currentIndex, direction)
    direction = next.direction
    const from = stations[currentIndex]
    const to = stations[next.nextIndex]
    const duration = segmentTravelMinutes(from, to, mode)
    segmentProgressMinutes = Math.min(segmentProgressMinutes, duration)
    const minutesToArrival = duration - segmentProgressMinutes

    if (remainingMinutes < minutesToArrival) {
      segmentProgressMinutes += remainingMinutes
      remainingMinutes = 0
      break
    }

    remainingMinutes -= minutesToArrival
    currentIndex = next.nextIndex
    segmentProgressMinutes = 0
    const arrivedStation = stations[currentIndex]
    const isStop = !stopStationIds || stopStationIds.has(arrivedStation.id)
    if (!isStop) continue // 급행 통과역 — 정차 없이 바로 다음 구간으로

    dwellRemainingMinutes = stationDwellMinutes(mode)
    arrivedStationIds.push(arrivedStation.id)

    // 정확히 역에 도착한 시점이면 다음 호출에서 정차 시간을 소비한다.
    if (remainingMinutes === 0) break
  }

  const next = nextStation(stations, currentIndex, direction)
  direction = next.direction
  const from = stations[currentIndex]
  const to = stations[next.nextIndex]
  const segmentDurationMinutes = segmentTravelMinutes(from, to, mode)
  const isDwelling = dwellRemainingMinutes > 0
  const progress = !isDwelling && segmentDurationMinutes > 0
    ? Math.max(0, Math.min(1, segmentProgressMinutes / segmentDurationMinutes))
    : 0
  const persistedProgressMinutes = isDwelling ? -dwellRemainingMinutes : segmentProgressMinutes

  return {
    currentStationId: from.id,
    nextStationId: to.id,
    direction,
    segmentProgressMinutes: persistedProgressMinutes,
    dwellRemainingMinutes,
    isDwelling,
    segmentDurationMinutes,
    progress,
    x: from.posX + (to.posX - from.posX) * progress,
    y: from.posY + (to.posY - from.posY) * progress,
    arrivedStationIds,
  }
}

/**
 * 노선 중간에 새 역을 끼워 넣을 때, 마침 그 구간을 지나던 차량의 진행 상태를 새 구간
 * 기준으로 다시 계산한다. 그대로 두면 advanceVehicleMotion의 구간 길이 클램프 때문에
 * (예전 긴 구간 기준 진행 시간이 훨씬 짧아진 새 구간 길이를 넘어서) 차량이 새 역까지
 * 순간이동한 것처럼 보인다. 실제 이동한 물리적 거리를 보존해 자연스럽게 이어지게 한다.
 * 정차 중이거나 삽입되는 구간을 지나고 있지 않으면 null(변경 없음)을 반환한다.
 */
export function reconcileVehicleForInsertedStation(
  stations: MotionStation[],
  state: VehicleMotionState,
  segmentStationIds: readonly [string, string],
  insertedStation: MotionStation,
  mode: TransitMode,
): { currentStationId: string; segmentProgressMinutes: number } | null {
  if (!state.currentStationId) return null
  const before = advanceVehicleMotion(stations, state, 0, mode)
  if (before.isDwelling || !before.nextStationId) return null

  const [aId, bId] = segmentStationIds
  const matchesForward = before.currentStationId === aId && before.nextStationId === bId
  const matchesReverse = before.currentStationId === bId && before.nextStationId === aId
  if (!matchesForward && !matchesReverse) return null

  const startStation = stations.find(station => station.id === before.currentStationId)
  const endStation = stations.find(station => station.id === before.nextStationId)
  if (!startStation || !endStation) return null

  const distStartEnd = Math.hypot(endStation.posX - startStation.posX, endStation.posY - startStation.posY)
  const distStartMid = Math.hypot(insertedStation.posX - startStation.posX, insertedStation.posY - startStation.posY)
  const distMidEnd = Math.hypot(endStation.posX - insertedStation.posX, endStation.posY - insertedStation.posY)
  const traveledDistance = before.progress * distStartEnd

  if (distStartMid <= 0 || traveledDistance <= distStartMid) {
    const fraction = distStartMid > 0 ? Math.min(1, traveledDistance / distStartMid) : 0
    return {
      currentStationId: startStation.id,
      segmentProgressMinutes: fraction * segmentTravelMinutes(startStation, insertedStation, mode),
    }
  }

  const remaining = traveledDistance - distStartMid
  const fraction = distMidEnd > 0 ? Math.min(1, remaining / distMidEnd) : 0
  return {
    currentStationId: insertedStation.id,
    segmentProgressMinutes: fraction * segmentTravelMinutes(insertedStation, endStation, mode),
  }
}
