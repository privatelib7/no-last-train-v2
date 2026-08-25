import type { GameLine, Station, StationType } from './api/game'
import type { CityMapDef, ZoneKind } from './maps'
import { pointInPolygon } from './maps'
import { stationDemandWeights } from './demand-profile'

export type CitizenTravelMode = 'WALK' | 'WAIT' | 'BOARDING'
export type StationAccessMode = 'SUBWAY' | 'BUS' | 'INTERCHANGE' | 'CITY'

type Point = { x: number; y: number }

type JourneyLeg = {
  from: Point
  to: Point
  mode: CitizenTravelMode
  duration: number
}

export type CitizenJourney = {
  id: string
  /** 시민 슬롯 번호 — 여정이 새로 뽑혀도 유지되어 화면상 같은 점으로 이어진다. */
  index: number
  /** 이 슬롯이 몇 번째 여정인지 — 매번 다른 목적지를 뽑기 위한 salt. */
  generation: number
  /** 이 여정이 시작된 journeyTime. 여정은 반복되지 않고 끝나면 새로 뽑는다. */
  startTime: number
  /** 이 시민이 사는 자리. 슬롯마다 고정이라 모든 여정이 여기서 시작해 여기로 돌아온다. */
  home: Point
  targetStationId: string
  targetStationName: string
  accessMode: StationAccessMode
  legs: JourneyLeg[]
  totalDuration: number
  radius: number
  opacity: number
  warm: boolean
  landSafe: boolean
}

export type CitizenPosition = {
  x: number
  y: number
  mode: CitizenTravelMode
  progress: number
  opacityScale: number
  radiusScale: number
}

type StationWeights = Record<StationType, number>
type StationOption = { station: Station; accessMode: StationAccessMode }

/**
 * 걸어서 역까지 갈 수 있다고 보는 최대 거리 (viewBox 0~100 기준, 1 ≈ 300m).
 * 이 반경 밖에 사는 사람은 역으로 가지 않는다 — 맵 반대편에서 역까지 걸어오지 않게 하는 손잡이.
 */
export const CITIZEN_WALK_RANGE = 12
/** 역이 없어도 사람은 산다 — 동네 볼일로 오가는 반경. */
export const CITIZEN_ERRAND_RANGE = 7

/** 집을 용도지역에 얼마나 몰아줄지. 나머지는 육지 전역에 고르게 흩어진다. */
const HOME_IN_ZONE_SHARE = 0.6
const HOME_ZONE_WEIGHTS: Record<ZoneKind, number> = {
  residential: 3.2,
  commercial: 1.6,
  industrial: 0.8,
}

function randomUnit(seed: number, index: number, salt: number) {
  let value = Math.imul(seed + index * 374761393 + salt * 668265263, 1274126177)
  value ^= value >>> 13
  value = Math.imul(value, 2246822519)
  return (value >>> 0) / 4294967296
}

function distanceBetween(from: Point, to: Point) {
  return Math.hypot(to.x - from.x, to.y - from.y)
}

// 두 지점 사이를 촘촘히 표본화해 강·바다·도시 경계 밖을 한 번이라도 지나면 거부한다.
export function pathStaysOnLand(from: Point, to: Point, map: CityMapDef) {
  const distance = distanceBetween(from, to)
  const steps = Math.max(2, Math.ceil(distance / 0.22))
  for (let step = 0; step <= steps; step++) {
    const progress = step / steps
    const x = from.x + (to.x - from.x) * progress
    const y = from.y + (to.y - from.y) * progress
    if (!map.isLand(x, y)) return false
  }
  return true
}

/** 노선 유무와 관계없이 모든 역을 목적지 후보로 쓴다. */
function allStationsWithAccess(lines: GameLine[], stations: Station[]): StationOption[] {
  const modesByStation = new Map<string, Set<'SUBWAY' | 'BUS'>>()
  for (const line of lines) {
    for (const item of line.lineStations) {
      if (!modesByStation.has(item.stationId)) modesByStation.set(item.stationId, new Set())
      modesByStation.get(item.stationId)!.add(line.mode)
    }
  }

  return stations.map(station => {
    const modes = modesByStation.get(station.id)
    const accessMode: StationAccessMode = !modes || modes.size === 0
      ? 'SUBWAY'
      : modes.size > 1
        ? 'INTERCHANGE'
        : modes.has('BUS') ? 'BUS' : 'SUBWAY'
    return { station, accessMode }
  })
}

/** 집에서 걸어갈 만한 거리에 있고, 물을 건너지 않고 닿는 역만 남긴다. */
function stationsWithinWalk(home: Point, options: StationOption[], map: CityMapDef): StationOption[] {
  const reachable: StationOption[] = []
  for (const option of options) {
    const point = { x: option.station.posX, y: option.station.posY }
    // 육로 판정은 표본이 많아 비싸다 — 반경으로 먼저 거른 역만 확인한다.
    if (distanceBetween(home, point) > CITIZEN_WALK_RANGE) continue
    if (!pathStaysOnLand(home, point, map)) continue
    reachable.push(option)
  }
  return reachable
}

/** 가까운 역일수록, 그 시각 수요가 큰 역일수록 잘 뽑힌다. */
function pickWeightedStation(
  options: StationOption[],
  weights: StationWeights,
  home: Point,
  roll: number,
): StationOption | null {
  const scored = options.map(option => {
    const distance = distanceBetween(home, { x: option.station.posX, y: option.station.posY })
    const proximity = 1 - 0.72 * Math.min(1, distance / CITIZEN_WALK_RANGE)
    return { option, score: (weights[option.station.type] ?? 1) * proximity }
  })
  const total = scored.reduce((sum, item) => sum + item.score, 0)
  if (total <= 0) return options[options.length - 1] ?? null
  let cursor = roll * total
  for (const item of scored) {
    cursor -= item.score
    if (cursor <= 0) return item.option
  }
  return options[options.length - 1] ?? null
}

/**
 * 역세권에 살아도 매번 역으로 나가지는 않는다. 수요가 큰 시각일수록 자주 나간다
 * (수요 곡선은 도시 평균 역에서 1.0 근처).
 */
function stationTripChance(weight: number) {
  return Math.min(0.9, Math.max(0.15, 0.18 + weight * 0.62))
}

function deterministicLandPoint(map: CityMapDef, seed: number, index: number, salt: number): Point {
  for (let attempt = 0; attempt < 96; attempt++) {
    const point = {
      x: 4 + randomUnit(seed, index, salt + attempt * 2) * 92,
      y: 4 + randomUnit(seed, index, salt + attempt * 2 + 1) * 92,
    }
    if (map.isLand(point.x, point.y)) return point
  }

  const anchor = { x: map.anchor[0], y: map.anchor[1] }
  if (map.isLand(anchor.x, anchor.y)) return anchor

  for (let y = 2; y <= 98; y += 2) {
    for (let x = 2; x <= 98; x += 2) {
      if (map.isLand(x, y)) return { x, y }
    }
  }

  return anchor
}

/** 주거지에 사람이 몰리고 상업·산업지에도 얼마간 산다 — 도시가 잡음이 아니라 동네처럼 보이도록. */
function zoneHomePoint(map: CityMapDef, seed: number, index: number): Point | null {
  if (map.zones.length === 0) return null

  const total = map.zones.reduce((sum, zone) => sum + HOME_ZONE_WEIGHTS[zone.kind], 0)
  let cursor = randomUnit(seed, index, 611) * total
  let picked = map.zones[map.zones.length - 1]
  for (const zone of map.zones) {
    cursor -= HOME_ZONE_WEIGHTS[zone.kind]
    if (cursor <= 0) {
      picked = zone
      break
    }
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of picked.points) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }

  for (let attempt = 0; attempt < 24; attempt++) {
    const point = {
      x: minX + randomUnit(seed, index, 620 + attempt * 2) * (maxX - minX),
      y: minY + randomUnit(seed, index, 621 + attempt * 2) * (maxY - minY),
    }
    if (!pointInPolygon(point.x, point.y, picked.points)) continue
    if (!map.isLand(point.x, point.y)) continue
    return point
  }
  return null
}

/**
 * 시민이 사는 자리 — 슬롯마다 고정이고 역이 있든 없든 맵 전역에 생긴다.
 * 노선을 깔지 않은 동네에도 사람이 살아 있게 하는 지점.
 */
function citizenHome(map: CityMapDef, seed: number, index: number): Point {
  if (randomUnit(seed, index, 610) < HOME_IN_ZONE_SHARE) {
    const zoned = zoneHomePoint(map, seed, index)
    if (zoned) return zoned
  }
  return deterministicLandPoint(map, seed, index, 500)
}

/** 집을 중심으로 한 원 안에서, 물을 건너지 않고 걸어갈 수 있는 지점을 고른다. */
function localLandPoint(
  origin: Point,
  minRadius: number,
  maxRadius: number,
  map: CityMapDef,
  seed: number,
  index: number,
  salt: number,
): Point | null {
  for (let attempt = 0; attempt < 40; attempt++) {
    const angle = randomUnit(seed, index, salt + attempt * 2) * Math.PI * 2
    // sqrt를 씌워야 원 안에 고르게 퍼진다 (안 그러면 중심에 뭉친다).
    const radius = minRadius
      + (maxRadius - minRadius) * Math.sqrt(randomUnit(seed, index, salt + attempt * 2 + 1))
    const point = {
      x: origin.x + Math.cos(angle) * radius,
      y: origin.y + Math.sin(angle) * radius,
    }
    if (point.x < 2 || point.x > 98 || point.y < 2 || point.y > 98) continue
    if (!map.isLand(point.x, point.y)) continue
    if (!pathStaysOnLand(origin, point, map)) continue
    return point
  }
  return null
}

type CitizenAppearance = {
  radius: number
  opacity: number
  warm: boolean
}

function citizenAppearance(seed: number, index: number): CitizenAppearance {
  // 외형은 슬롯마다 고정 — 여정이 새로 뽑혀도 같은 사람으로 보이게 한다.
  return {
    radius: 0.4 + randomUnit(seed, index, 341) * 0.14,
    opacity: 0.72 + randomUnit(seed, index, 342) * 0.24,
    warm: randomUnit(seed, index, 343) > 0.76,
  }
}

/**
 * 걸어갈 만한 역이 없거나, 있어도 이번엔 나가지 않는 사람의 여정.
 * 집 근처를 오가기만 하므로 역이 없는 동네도 비어 보이지 않는다.
 */
function createAmbientJourney(
  seed: number,
  index: number,
  generation: number,
  map: CityMapDef,
  home: Point,
): CitizenJourney {
  const salt = 500 + generation * 6151
  const destination = localLandPoint(home, 2.2, CITIZEN_ERRAND_RANGE, map, seed, index, salt + 200)
    ?? home
  const walkDuration = Math.max(2.2, distanceBetween(home, destination) / 1.3)
  const stayDuration = 1.2 + randomUnit(seed, index, salt + 440) * 2.4
  const restDuration = 1 + randomUnit(seed, index, salt + 441) * 3
  const legs: JourneyLeg[] = [
    { from: home, to: destination, mode: 'WALK', duration: walkDuration },
    { from: destination, to: destination, mode: 'WAIT', duration: stayDuration },
    { from: destination, to: home, mode: 'WALK', duration: walkDuration },
    { from: home, to: home, mode: 'WAIT', duration: restDuration },
  ]

  return {
    id: `citizen-${index}`,
    index,
    generation,
    startTime: 0,
    home,
    targetStationId: 'city-ambient',
    targetStationName: map.name,
    accessMode: 'CITY',
    legs,
    totalDuration: legs.reduce((sum, leg) => sum + leg.duration, 0),
    ...citizenAppearance(seed, index),
    landSafe: pathStaysOnLand(home, destination, map),
  }
}

/** 집에서 걸어 나와 역까지 가는 여정. 이번 세대엔 나가지 않기로 하면 null. */
function createStationJourney(
  seed: number,
  index: number,
  generation: number,
  map: CityMapDef,
  home: Point,
  reachable: StationOption[],
  weights: StationWeights,
): CitizenJourney | null {
  const salt = 120 + generation * 7919
  // 걸어갈 만한 버스 정류장이 있으면 일부 시민은 그쪽으로 향하게 한다.
  const busStops = reachable.filter(item => item.accessMode === 'BUS')
  const forcedBusStop = busStops.length > 0 && (index + generation) % 12 === 0
    ? busStops[(index + generation) % busStops.length]
    : null
  const target = forcedBusStop ?? pickWeightedStation(
    reachable,
    weights,
    home,
    randomUnit(seed, index, salt),
  )
  if (!target) return null

  const weight = weights[target.station.type] ?? 1
  if (randomUnit(seed, index, salt + 71) > stationTripChance(weight)) return null

  const stationPoint = { x: target.station.posX, y: target.station.posY }
  const walkDuration = Math.max(2.4, distanceBetween(home, stationPoint) / 1.8)
  const leaveHomeDelay = 0.6 + randomUnit(seed, index, salt + 72) * 2.6
  const legs: JourneyLeg[] = [
    { from: home, to: home, mode: 'WAIT', duration: leaveHomeDelay },
    { from: home, to: stationPoint, mode: 'WALK', duration: walkDuration },
    { from: stationPoint, to: stationPoint, mode: 'WAIT', duration: 1.45 },
    { from: stationPoint, to: stationPoint, mode: 'BOARDING', duration: 0.9 },
  ]

  return {
    id: `citizen-${index}`,
    index,
    generation,
    startTime: 0,
    home,
    targetStationId: target.station.id,
    targetStationName: target.station.name,
    accessMode: target.accessMode,
    legs,
    totalDuration: legs.reduce((sum, leg) => sum + leg.duration, 0),
    ...citizenAppearance(seed, index),
    landSafe: pathStaysOnLand(home, stationPoint, map),
  }
}

export type CitizenWorldOptions = {
  seed: number
  waitingCount: number
  gameHour: number
  weekend: boolean
  stations: Station[]
  lines: GameLine[]
  map: CityMapDef
}

/**
 * 이미 이동 중인 시민은 그대로 두고, 여정을 끝낸 시민만 새 여정을 받는다.
 * 역을 짓거나 노선을 바꿔도 화면 위의 사람들이 한꺼번에 순간이동하지 않게 하기 위함.
 */
export function advanceCitizenJourneys(
  options: CitizenWorldOptions & {
    previous: CitizenJourney[]
    journeyTime: number
    /** 한 프레임에 새로 뽑을 여정 수 상한 — 여정 생성은 육지 탐색이라 비싸다. */
    maxRespawns?: number
  },
): CitizenJourney[] {
  const { seed, waitingCount, gameHour, weekend, stations, lines, map, previous, journeyTime } = options
  // 사람이 노선 주변이 아니라 도시 전역에 흩어져 살므로 예전(24~48)보다 조금 더 채운다.
  const count = Math.min(64, Math.max(32, Math.round(28 + Math.log10(waitingCount + 10) * 12)))
  const allStations = allStationsWithAccess(lines, stations)
  // 서버 승객 생성과 같은 공공데이터 프로필을 써서 화면 위 사람 흐름을 맞춘다.
  // map.key가 어느 도시 곡선을 쓸지 정한다 (부산 맵이면 부산 지하철 실측).
  const weights = stationDemandWeights(map.key, gameHour, weekend) as StationWeights

  const remaining = new Map(previous.map(journey => [journey.index, journey]))
  let respawnBudget = options.maxRespawns ?? 12
  const journeys: CitizenJourney[] = []

  for (let index = 0; index < count; index++) {
    const current = remaining.get(index)
    remaining.delete(index)
    // 아직 걷는 중이면 목적지·경로를 절대 건드리지 않는다.
    if (current && journeyTime < current.startTime + current.totalDuration) {
      journeys.push(current)
      continue
    }
    // 예산을 넘겼으면 다음 프레임에 뽑는다. 여정을 끝낸 시민은 이미 투명해 보이지 않는다.
    if (respawnBudget <= 0) {
      if (current) journeys.push(current)
      continue
    }
    respawnBudget -= 1

    const generation = (current?.generation ?? -1) + 1
    // 집은 슬롯마다 고정 — 역이 새로 생겨도 살던 동네가 바뀌지는 않는다.
    const home = current?.home ?? citizenHome(map, seed, index)
    const reachable = allStations.length > 0 ? stationsWithinWalk(home, allStations, map) : []
    const next = (reachable.length > 0
      ? createStationJourney(seed, index, generation, map, home, reachable, weights)
      : null)
      // 걸어갈 역이 없거나 오늘은 나가지 않기로 한 사람은 동네에 남는다.
      ?? createAmbientJourney(seed, index, generation, map, home)

    // 처음 들어오는 시민은 서로 다른 위상에서 시작시켜 한 줄로 몰려다니지 않게 한다.
    // (바로 여정이 끝나버리지 않도록 0.85 주기까지만 밀어 둔다)
    const stagger = current ? 0 : randomUnit(seed, index, 340) * next.totalDuration * 0.85
    const chained = current ? current.startTime + current.totalDuration : journeyTime - stagger
    // 탭이 오래 멈춰 여러 주기가 밀렸거나 시계가 되감긴 경우엔 현재 시각에 맞춘다.
    const drifted = chained > journeyTime || journeyTime - chained > next.totalDuration
    next.startTime = drifted ? journeyTime - stagger : chained
    journeys.push(next)
  }

  // 정원이 줄어든 슬롯도 진행 중인 여정은 끝까지 걷게 둔다 (도중에 사라지지 않도록).
  for (const leftover of remaining.values()) {
    if (journeyTime < leftover.startTime + leftover.totalDuration) journeys.push(leftover)
  }

  return journeys.sort((a, b) => a.index - b.index)
}

/** 도시를 처음 열 때의 초기 채움. */
export function createCitizenJourneys(options: CitizenWorldOptions): CitizenJourney[] {
  return advanceCitizenJourneys({ ...options, previous: [], journeyTime: 0, maxRespawns: Infinity })
}

export function locateCitizen(journey: CitizenJourney, journeyTime: number): CitizenPosition {
  const elapsed = Math.min(journey.totalDuration, Math.max(0, journeyTime - journey.startTime))
  let cursor = elapsed
  let leg = journey.legs[journey.legs.length - 1]

  for (const candidate of journey.legs) {
    if (cursor <= candidate.duration) {
      leg = candidate
      break
    }
    cursor -= candidate.duration
  }

  const progress = leg.duration > 0 ? Math.min(1, cursor / leg.duration) : 1
  // 여정 앞뒤를 페이드로 감싼다 — 다음 여정을 받을 때 다른 자리에서 튀어나오지 않도록.
  const fadeSpan = Math.min(1.1, journey.totalDuration * 0.1)
  const envelope = fadeSpan > 0
    ? Math.min(1, elapsed / fadeSpan, (journey.totalDuration - elapsed) / fadeSpan)
    : 1
  const opacityScale = (leg.mode === 'BOARDING' ? 1 - progress : 1) * envelope
  const radiusScale = leg.mode === 'BOARDING' ? Math.max(0.35, 1 - progress * 0.65) : 1

  return {
    x: leg.from.x + (leg.to.x - leg.from.x) * progress,
    y: leg.from.y + (leg.to.y - leg.from.y) * progress,
    mode: leg.mode,
    progress,
    opacityScale,
    radiusScale,
  }
}
