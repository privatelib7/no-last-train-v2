// 공공데이터에서 뽑은 수요 프로필을 시뮬레이션이 쓰는 배율로 바꿔 준다.
//
// 맵(City.mapKey)마다 그 도시의 실제 지하철 승하차를 쓴다.
//   SEOUL  서울열린데이터광장 «서울교통공사_역별 일별 시간대별 승하차인원 정보»(OA-12921)
//   BUSAN  공공데이터포털 «부산교통공사_시간대별 승하차인원»(3057229)
// 갱신: `npm run data:demand -w no-last-train-server` → scripts/build-demand-profile.mjs
//
// 실측 곡선을 그대로 쓰면 게임이 아니라 통계 재생기가 된다. 새벽엔 화면이 텅 비고,
// 거점역은 평균의 12배까지 튀어서 어떤 배차로도 못 버틴다. 그래서 «모양은 실제,
// 세기는 조절 가능»하도록 손잡이 네 개를 건다. 손잡이를 어떻게 돌려도 도시 전체
// 하루 총수요는 그대로다(마지막에 재정규화) — 경제 밸런스가 흔들리지 않는다.
//
// 도시별 정규화도 각자 1.0 기준이다. 부산 도시가 서울 도시보다 «가난»해지지 않고,
// 들어오는 건 부산의 절대 승객 수가 아니라 부산의 «곡선 모양»이다.

import profile from '@/data/demand-profile.json'

export type StationTypeKey = 'RESIDENTIAL' | 'COMMERCIAL' | 'TOURIST' | 'INDUSTRIAL' | 'HUB'
export type DayTypeKey = 'WEEKDAY' | 'WEEKEND'
export type CityKey = keyof typeof profile.cities

export const STATION_TYPE_KEYS: StationTypeKey[] = ['RESIDENTIAL', 'COMMERCIAL', 'TOURIST', 'INDUSTRIAL', 'HUB']
export const CITY_KEYS = Object.keys(profile.cities) as CityKey[]
// client/src/maps.ts의 기본 맵과 맞춘다 — 모르는 mapKey는 부산으로 본다.
export const DEFAULT_CITY: CityKey = 'BUSAN'

const DAY_TYPE_KEYS: DayTypeKey[] = ['WEEKDAY', 'WEEKEND']
const HOURS = 24

export const DEMAND_TUNING = {
  // 시간대 기복. 1이면 실측 곡선 그대로, 0이면 하루 종일 평평.
  REALISM: 0.85,
  // 역 타입 사이의 «규모» 차이를 얼마나 살릴지. 1이면 실제 비율(거점역이 평균의 4배쯤),
  // 0이면 모든 타입이 같은 규모. 게임의 역은 실제 강남역만 한 수용력이 없다.
  TYPE_LEVEL_COMPRESSION: 0.5,
  // 실제 지하철은 새벽에 안 다녀서 원본이 0에 가깝다. 게임은 24시간 돌아가므로 최저치를 준다.
  // 그 타입의 평균 수요 대비 비율이다.
  NIGHT_FLOOR: 0.15,
  // 한 역이 한 시간에 뿜는 승객의 상한(도시 평균 대비). 실측 퇴근 피크를 그대로 두면
  // 예비 차량을 다 넣어도 못 막는 구간이 생긴다. 총량 재정규화 «전»에 걸리는 값이라
  // 최종 상한은 이보다 조금 낮게 나온다(현재 3.0 근처).
  MAX_WEIGHT: 3.5,
  // 게임 맵 1칸이 실제 몇 km인가. 서울 맵의 서울역(44,36)↔강남역(60,64)은 32칸인데
  // 실제 두 역은 직선 9.6km 떨어져 있다 → 0.3. 맵 전체(100칸)가 30km로 서울 시가지 폭과 맞는다.
  KM_PER_MAP_UNIT: 0.3,
  // 거리 감쇠를 얼마나 살릴지. 0이면 거리를 무시(노선 끝과 옆 역이 동등), 1이면 실측 그대로.
  DISTANCE_STRENGTH: 1,
  // 유형쌍 친화도를 얼마나 살릴지. 0이면 유형 간 선호 없음, 1이면 실측 그대로.
  AFFINITY_STRENGTH: 1,
} as const

const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length

type Table = Record<StationTypeKey, Record<DayTypeKey, number[]>>

// «평균 역»을 정의할 때 쓰는 기준 구성. 실제 도시의 분포(서울은 271곳 중 152곳이 주거역)가
// 아니라 게임이 만드는 도시의 구성(prisma/seed.ts, 주거·상업·관광 각 4 + 산업·거점 각 2)이다.
// 실제 분포로 정규화하면 역이 많은 유형의 곡선이 «평균»을 독차지해 총수요가 부풀어 오른다.
const REFERENCE_MIX: Record<StationTypeKey, number> = {
  RESIDENTIAL: 4, COMMERCIAL: 4, TOURIST: 4, INDUSTRIAL: 2, HUB: 2,
}
const REFERENCE_STATIONS = STATION_TYPE_KEYS.reduce((acc, t) => acc + REFERENCE_MIX[t], 0)

// 손잡이를 순서대로 먹인다: 규모 압축 → 시간 기복 완화 → 심야 바닥 → 상한 → 총량 복원.
function tune(source: Table, { renormalize }: { renormalize: boolean }): Table {
  const level = Object.fromEntries(
    STATION_TYPE_KEYS.map(t => [t, mean(source[t].WEEKDAY)]),
  ) as Record<StationTypeKey, number>

  // 규모 압축. 타입별 평균만 level^c로 줄이고 시간대 모양은 건드리지 않는다.
  const compressed = Object.fromEntries(
    STATION_TYPE_KEYS.map(t => [t, Math.pow(level[t], DEMAND_TUNING.TYPE_LEVEL_COMPRESSION)]),
  ) as Record<StationTypeKey, number>
  const weighted = (m: Record<StationTypeKey, number>) =>
    STATION_TYPE_KEYS.reduce((acc, t) => acc + m[t] * REFERENCE_MIX[t], 0)
  const levelFix = weighted(level) / (weighted(compressed) || 1)

  const out = {} as Table
  for (const type of STATION_TYPE_KEYS) {
    const scaled = compressed[type] * levelFix
    const gain = scaled / (level[type] || 1)
    out[type] = { WEEKDAY: [], WEEKEND: [] }
    for (const dayType of DAY_TYPE_KEYS) {
      const base = source[type][dayType].map(v => v * gain)
      const flat = mean(base)
      out[type][dayType] = base.map(v => {
        const eased = DEMAND_TUNING.REALISM * v + (1 - DEMAND_TUNING.REALISM) * flat
        const floored = Math.max(eased, DEMAND_TUNING.NIGHT_FLOOR * scaled)
        return Math.min(floored, DEMAND_TUNING.MAX_WEIGHT)
      })
    }
  }

  if (!renormalize) return out
  // 기준 구성의 도시에서 «평일 하루·시간 평균 = 1.0»이 되게 맞춘다. 주말은 같은 계수로
  // 나눠 주말/평일 비(서울 0.65, 부산 0.75)를 지킨다. 손잡이를 돌려도 총수요는 고정된다.
  const after = STATION_TYPE_KEYS
    .reduce((acc, t) => acc + mean(out[t].WEEKDAY) * REFERENCE_MIX[t], 0) / REFERENCE_STATIONS
  const fix = 1 / (after || 1)
  for (const type of STATION_TYPE_KEYS) {
    for (const dayType of DAY_TYPE_KEYS) {
      out[type][dayType] = out[type][dayType].map(v => v * fix)
    }
  }
  return out
}

type CityTables = {
  origin: Table
  dest: Table
  hourly: Record<DayTypeKey, number[]>
  dayOfWeek: number[]
}

const cities = Object.fromEntries(
  CITY_KEYS.map(key => {
    const raw = profile.cities[key]
    const origin = tune(raw.origin as Table, { renormalize: true })
    // 목적지 가중치는 상대값만 쓰이므로 총량 복원이 필요 없다.
    const dest = tune(raw.dest as Table, { renormalize: false })
    const hourly = Object.fromEntries(DAY_TYPE_KEYS.map(dayType => [
      dayType,
      Array.from({ length: HOURS }, (_, h) =>
        STATION_TYPE_KEYS.reduce((acc, t) => acc + origin[t][dayType][h] * REFERENCE_MIX[t], 0) / REFERENCE_STATIONS),
    ])) as Record<DayTypeKey, number[]>
    return [key, { origin, dest, hourly, dayOfWeek: raw.dayOfWeek } satisfies CityTables]
  }),
) as Record<CityKey, CityTables>

const wrapHour = (hour: number) => ((Math.floor(hour) % HOURS) + HOURS) % HOURS
const wrapDay = (dayIndex: number) => ((dayIndex % 7) + 7) % 7
const tablesOf = (city: string) => cities[city as CityKey] ?? cities[DEFAULT_CITY]

// ─── 공개 API ────────────────────────────────────────────────────────────

/** 요일 인덱스는 0=월 … 6=일 */
export function dayTypeOf(dayIndex: number): DayTypeKey {
  return wrapDay(dayIndex) >= 5 ? 'WEEKEND' : 'WEEKDAY'
}

/** 평일 5일은 평일 평균 대비, 토·일은 주말 평균 대비 배율 (두 도시 다 토요일이 가장 붐빈다) */
export function dayOfWeekMultiplier(city: string, dayIndex: number): number {
  return tablesOf(city).dayOfWeek[wrapDay(dayIndex)] ?? 1
}

/** 시간대 + 요일을 합친 도시 전체 수요 배율. 평일 하루 평균이 1.0이다. */
export function demandMultiplier(city: string, hour: number, dayIndex: number): number {
  return tablesOf(city).hourly[dayTypeOf(dayIndex)][wrapHour(hour)] * dayOfWeekMultiplier(city, dayIndex)
}

/** 그 시각 그 타입의 역이 승객을 «내보내는» 세기. 도시 평균 역·평균 시간이 1.0. */
export function originWeight(city: string, type: string, hour: number, dayIndex: number): number {
  const table = tablesOf(city).origin
  const curve = table[type as StationTypeKey] ?? table.RESIDENTIAL
  return curve[dayTypeOf(dayIndex)][wrapHour(hour)] * dayOfWeekMultiplier(city, dayIndex)
}

/** 그 시각 그 타입의 역이 승객을 «끌어당기는» 세기. 목적지 추첨 가중치로 쓴다. */
export function destWeight(city: string, type: string, hour: number, dayIndex: number): number {
  const table = tablesOf(city).dest
  const curve = table[type as StationTypeKey] ?? table.RESIDENTIAL
  return curve[dayTypeOf(dayIndex)][wrapHour(hour)]
}

// ─── 목적지 선택 ─────────────────────────────────────────────────────────
//
// 예전에는 목적지를 «도착 역 타입의 그 시각 매력도»만으로 뽑아서, 두 정거장 옆 역과
// 노선 반대쪽 끝 역이 완전히 동등했다. 실제 통행은 그렇지 않다 — 서울 지하철 역간 OD를
// 재 보면 거리에 따라 exp(-d/7.6km)로 떨어진다(R²=0.96, 평균 통행 7.0km).
//
// 유형쌍 친화도는 그 위에 남는 «유형 때문»의 편차다. 거의 1.0에 가깝고(거리와 역 규모가
// 대부분을 설명한다) 거점↔거점만 1.57로 뚜렷하다. 측정된 OD가 일요일 하루치뿐이라
// 평일 전용 친화도는 만들 수 없어, 이 한 벌을 두 요일 모두에 쓴다.

const OD = profile.od
const affinityOf = (originType: string, destType: string) => {
  const row = (OD.affinity as Record<string, Record<string, number>>)[originType]
  return row?.[destType] ?? 1
}

/** 두 역의 맵 좌표 거리를 실제 km로 환산한 값 */
export function mapDistanceToKm(distanceInMapUnits: number): number {
  return distanceInMapUnits * DEMAND_TUNING.KM_PER_MAP_UNIT
}

/**
 * 목적지 추첨 가중치. «그 시각 그 타입이 끌어당기는 힘 × 거리 감쇠 × 유형쌍 친화도».
 * 셋 다 공공데이터 실측에서 나왔고, 각각 손잡이로 세기를 줄일 수 있다.
 */
export function destinationScore(
  city: string,
  originType: string,
  destType: string,
  hour: number,
  dayIndex: number,
  distanceInMapUnits: number,
): number {
  const attraction = destWeight(city, destType, hour, dayIndex)
  const decay = Math.exp(
    (-mapDistanceToKm(distanceInMapUnits) / OD.deterrence.d0Km) * DEMAND_TUNING.DISTANCE_STRENGTH,
  )
  const affinity = 1 + (affinityOf(originType, destType) - 1) * DEMAND_TUNING.AFFINITY_STRENGTH
  return attraction * decay * affinity
}

export const OD_MODEL = OD

/** 어느 공공데이터에서 나온 곡선인지 — 출처 표시·검증용 */
export function demandProfileSource(city: string) {
  return (profile.cities[city as CityKey] ?? profile.cities[DEFAULT_CITY]).source
}
