import type { GameLine, Station } from './api/game'

export type LineEndBadge = {
  id: string
  line: GameLine
  label: string
  station: Station
  isHead: boolean
  x: number
  y: number
}

/**
 * 종점 중심에서 배지 중심까지 (지도 단위). 배지 반지름 1.65에 역 글리프 반지름이
 * 1 남짓이라 이 거리면 배지가 노선 끝에 붙어 보인다.
 */
const BADGE_GAP = 2.4
/** 배지끼리 겹치지 않는 최소 중심 간격 — hover 시 반지름 1.85의 두 배 */
const BADGE_CLEARANCE = 3.7
/** 남의 역 글리프를 가리지 않는 최소 간격 — 배지 1.65 + 환승역 헤일로 1.15 */
const STATION_CLEARANCE = 2.8
/**
 * 자리가 없으면 종점 둘레로 돌려서 피한다. 바깥으로 밀어내면 배지가 노선에서
 * 떨어져 나가 어느 선의 끝인지 읽히지 않는다. ±114°까지만 돌려 선로 위에는 앉히지 않는다.
 */
const FAN_DEGREES = [0, 38, -38, 76, -76, 114, -114]
/** 둘레를 다 돌아도 자리가 없을 때만 한 겹씩 바깥으로 (최대 BADGE_GAP + 2 × RING_STEP) */
const RING_STEP = 1.5
const RING_COUNT = 3

/** 배지가 종점에서 벌어질 수 있는 최대 거리 (지도 단위) */
export const BADGE_MAX_DISTANCE = BADGE_GAP + (RING_COUNT - 1) * RING_STEP

function orderedStations(line: GameLine) {
  return line.lineStations.slice().sort((a, b) => a.order - b.order).map(item => item.station)
}

type Point = { id?: string; x: number; y: number }

/** skipId(자기 종점)는 배지가 붙어 있어야 하는 대상이라 거리 계산에서 뺀다 */
function minDistanceTo(x: number, y: number, points: Point[], skipId?: string) {
  let best = Number.POSITIVE_INFINITY
  for (const point of points) {
    if (skipId !== undefined && point.id === skipId) continue
    const distance = Math.hypot(point.x - x, point.y - y)
    if (distance < best) best = distance
  }
  return best
}

/**
 * 종점 둘레에서 배지가 앉을 자리를 고른다. 노선이 들어오는 방향(직전 역 → 종점)의
 * 바로 바깥이 1순위고, 이미 놓인 배지나 남의 역과 부딪히면 같은 거리에서 각도만
 * 돌려 가며 찾는다. 어디에도 자리가 없으면 여유가 가장 큰 자리를 쓴다.
 */
function pickBadgeSpot(
  terminus: Station,
  outwardAngle: number,
  mapScale: number,
  placed: Point[],
  stationPoints: Point[],
) {
  const badgeClearance = BADGE_CLEARANCE * mapScale
  const stationClearance = STATION_CLEARANCE * mapScale
  let fallback: { x: number; y: number; score: number } | null = null

  for (let ring = 0; ring < RING_COUNT; ring += 1) {
    const distance = (BADGE_GAP + ring * RING_STEP) * mapScale
    for (const degrees of FAN_DEGREES) {
      const angle = outwardAngle + (degrees * Math.PI) / 180
      const x = terminus.posX + Math.cos(angle) * distance
      const y = terminus.posY + Math.sin(angle) * distance
      const badgeGap = minDistanceTo(x, y, placed)
      const stationGap = minDistanceTo(x, y, stationPoints, terminus.id)
      if (badgeGap >= badgeClearance && stationGap >= stationClearance) return { x, y }
      const score = Math.min(badgeGap / badgeClearance, stationGap / stationClearance)
      if (!fallback || score > fallback.score) fallback = { x, y, score }
    }
  }
  return fallback ?? { x: terminus.posX, y: terminus.posY }
}

/**
 * 노선 양 끝에 붙는 호선 번호 배지 위치. 종점이 같거나 가까운 노선끼리 배지가
 * 포개지므로, 종점 둘레를 돌려 겹침만 푼다 — 거리는 BADGE_MAX_DISTANCE로 묶여 있어
 * 배지가 노선에서 떨어져 떠 있지 않는다.
 */
export function layoutLineEndBadges(
  lines: GameLine[],
  stations: Station[],
  mapScale: number,
): LineEndBadge[] {
  const badges: LineEndBadge[] = []
  const stationPoints: Point[] = stations.map(station => ({ id: station.id, x: station.posX, y: station.posY }))
  for (const line of lines) {
    if (line.lineStations.length < 2) continue
    const stops = orderedStations(line)
    const label = line.name.match(/\d+/)?.[0] ?? line.name.slice(0, 1)
    for (const [isHead, at, prev] of [
      [true, stops[0], stops[1]] as const,
      [false, stops[stops.length - 1], stops[stops.length - 2]] as const,
    ]) {
      // 직전 역 → 종점 방향 바깥이 기본 자리다. 역 표시를 가리지 않는다.
      const outwardAngle = Math.atan2(at.posY - prev.posY, at.posX - prev.posX)
      const spot = pickBadgeSpot(at, outwardAngle, mapScale, badges, stationPoints)
      badges.push({ id: `${line.id}-${isHead ? 'head' : 'tail'}`, line, label, station: at, isHead, ...spot })
    }
  }
  return badges
}
