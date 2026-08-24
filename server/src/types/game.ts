import type { City, Line, Station, Vehicle, Passenger, Policy, GameEvent, SimTick, ActionLog } from '@prisma/client'

// ─── 시뮬레이션 상태 스냅샷 ──────────────────────────────────────────────

export interface CitySnapshot {
  city: City
  lines: LineSnapshot[]
  stations: StationSnapshot[]
  activeEvents: GameEvent[]
  lastTick: SimTick | null
}

export interface LineSnapshot {
  line: Line
  stations: Station[]
  vehicles: Vehicle[]
  activePolicies: Policy[]
  recentActions: ActionLog[]
}

export interface StationSnapshot {
  station: Station
  waitingCount: number
  congestion: number  // 0.0 ~ 1.0
  vehiclesPresent: number
}

// ─── 시뮬레이션 결과 ─────────────────────────────────────────────────────

export interface SimResult {
  ticksProcessed: number
  totalTransported: number
  /** 목적지까지 실제로 도착한 승객 수 — 태우기만 하고 못 내려 주면 이 값이 안 오른다 */
  totalArrived: number
  revenueEarned: number
  operatingCost: number
  peakCongestion: number
  serviceScore: number
  cashBalance: number
  happiness: number
  score: number
  goalReached: boolean
  gameOverReason: 'BANKRUPT' | 'HAPPINESS' | 'GOAL_DEADLINE' | null
  actionsFired: Array<{ description: string; actionType: string }>
  highlights: TickHighlight[]  // 주요 순간 최대 3개
}

export interface TickHighlight {
  tickNumber: number
  gameTimeHour: number
  type: 'CONGESTION' | 'AI_ACTION' | 'EVENT' | 'SUPPORT' | 'GOAL'
  description: string
  severity: 'INFO' | 'WARNING' | 'CRITICAL'
}

// ─── 정책 파싱 ───────────────────────────────────────────────────────────

export interface ParsedPolicy {
  type: 'CONGESTION_RESPONSE' | 'PASSENGER_PRIORITY' | 'SUPPORT_CONDITION'
  conditionStationId?: string
  conditionThreshold?: number
  conditionTimeStart?: number
  conditionTimeEnd?: number
  actionType: 'DEPLOY_SPARE' | 'ADJUST_HEADWAY' | 'LEND_VEHICLE'
  actionTargetLineId?: string
  resourceLimit: number
  parsedSummary: string
}

export type PolicyParseResult =
  | { ok: true; policy: ParsedPolicy }
  | { ok: false; reason: string; suggestion: string }

// ─── 복귀 리포트 ─────────────────────────────────────────────────────────

export interface ReturnReport {
  offlineTicks: number
  offlineGameHours: number
  totalTransported: number
  peakCongestion: number
  serviceScore: number
  supportsGiven: number
  supportsReceived: number
  topActions: ActionLog[]         // AI 핵심 행동 3개
  highlights: TickHighlight[]     // 주요 장면 3개
  recommendations: string[]       // AI 추천 정책 변경
}

// ─── 승객 경로 ───────────────────────────────────────────────────────────

export interface Route {
  segments: RouteSegment[]
  totalTransfers: number
  estimatedTicks: number
}

export interface RouteSegment {
  lineId: string
  fromStationId: string
  toStationId: string
}

// ─── 시뮬레이션 파라미터 ─────────────────────────────────────────────────

export const SIM = {
  TICKS_PER_GAME_HOUR: 6,       // 틱당 게임 10분, 6틱 = 게임 1시간
  GAME_HOURS_PER_DAY: 24,
  GAME_START_HOUR: 5,           // 새 도시는 05시에 시작하고, 하루도 05시에 바뀐다
  GAME_MINUTES_PER_TICK: 10,    // 경제 집계 틱과 별개로 차량은 이 시간을 연속 이동한다
  LIVE_TICK_MS: 3000,            // 실시간 웹 운행: 3초마다 1틱
  MAX_OFFLINE_HOURS: 12,         // 오프라인 보상 최대 12시간
  // 역마다 사람이 보이게 올리되, 적체 시 생성 감쇠로 무한 폭주는 막는다.
  // 수요 프로필(src/lib/demand-profile.ts)의 배율이 «평균 역·평균 시간 = 1.0»이라,
  // 손튜닝 표를 쓰던 시절(평균 0.86배 × 8)과 하루 총수요를 맞추려면 이 값이 7이다.
  BASE_PASSENGER_RATE: 7,
  CONGESTION_DEPLOY_DEFAULT: 0.8, // 기본 혼잡 대응 임계값
} as const

// ─── 게임 내 달력 ────────────────────────────────────────────────────────

const TICKS_PER_DAY = SIM.TICKS_PER_GAME_HOUR * SIM.GAME_HOURS_PER_DAY

/** 틱 → 게임 내 시각(0 이상 24 미만). 0틱이 05시라 «운행일»은 05시에 시작해 05시에 끝난다. */
export function gameHourOfTick(tick: number): number {
  const hour = tick / SIM.TICKS_PER_GAME_HOUR + SIM.GAME_START_HOUR
  return ((hour % 24) + 24) % 24
}

/** 게임 내 요일 — 0=월 … 6=일. 7일 주기로 6·7일차가 주말이다. */
export function dayIndexOfTick(tick: number): number {
  return Math.floor(tick / TICKS_PER_DAY) % 7
}

export function isWeekendTick(tick: number): boolean {
  return dayIndexOfTick(tick) >= 5
}

// 시간대·요일별 수요는 공공데이터에서 뽑은 프로필이 담당한다 → src/lib/demand-profile.ts
