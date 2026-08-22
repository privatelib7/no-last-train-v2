// 화면 위 시민이 어느 역으로 걸어가는지를 정하는 가중치.
//
// 서버 시뮬레이션(server/src/lib/demand-profile.ts)과 «같은» 공공데이터 프로필을 읽고
// 같은 손잡이 값을 쓴다. 두 워크스페이스가 코드를 공유하지 않아 계산을 옮겨 둔 것이니,
// 값을 바꿀 때는 서버 쪽과 함께 고쳐야 화면과 실제 승객 수가 어긋나지 않는다.
//
// 맵(CityMapDef.key)마다 그 도시의 실제 지하철 승하차 곡선을 쓴다.
// 원본 JSON은 `npm run data:demand -w no-last-train-server`가 양쪽에 함께 써 준다.

import profile from './data/demand-profile.json'

export type DemandDayType = 'WEEKDAY' | 'WEEKEND'

const TYPES = ['RESIDENTIAL', 'COMMERCIAL', 'TOURIST', 'INDUSTRIAL', 'HUB'] as const
type TypeKey = (typeof TYPES)[number]
type CityKey = keyof typeof profile.cities
const DAY_TYPES: DemandDayType[] = ['WEEKDAY', 'WEEKEND']
const HOURS = 24
// maps.ts의 기본 맵과 맞춘다 — 모르는 키는 부산으로 본다.
const DEFAULT_CITY: CityKey = 'BUSAN'

// server/src/lib/demand-profile.ts의 DEMAND_TUNING·REFERENCE_MIX와 같은 값이어야 한다.
const TUNING = { REALISM: 0.85, TYPE_LEVEL_COMPRESSION: 0.5, NIGHT_FLOOR: 0.15, MAX_WEIGHT: 3.5 }
const REFERENCE_MIX: Record<TypeKey, number> = {
  RESIDENTIAL: 4, COMMERCIAL: 4, TOURIST: 4, INDUSTRIAL: 2, HUB: 2,
}
const REFERENCE_STATIONS = TYPES.reduce((acc, t) => acc + REFERENCE_MIX[t], 0)

const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length

type Table = Record<TypeKey, Record<DemandDayType, number[]>>

function tune(source: Table): Table {
  const level = Object.fromEntries(TYPES.map(t => [t, mean(source[t].WEEKDAY)])) as Record<TypeKey, number>
  const compressed = Object.fromEntries(
    TYPES.map(t => [t, Math.pow(level[t], TUNING.TYPE_LEVEL_COMPRESSION)]),
  ) as Record<TypeKey, number>
  const weighted = (m: Record<TypeKey, number>) => TYPES.reduce((acc, t) => acc + m[t] * REFERENCE_MIX[t], 0)
  const levelFix = weighted(level) / (weighted(compressed) || 1)

  const out = {} as Table
  for (const type of TYPES) {
    const scaled = compressed[type] * levelFix
    const gain = scaled / (level[type] || 1)
    out[type] = { WEEKDAY: [], WEEKEND: [] }
    for (const dayType of DAY_TYPES) {
      const base = source[type][dayType].map(v => v * gain)
      const flat = mean(base)
      out[type][dayType] = base.map(v => Math.min(
        Math.max(TUNING.REALISM * v + (1 - TUNING.REALISM) * flat, TUNING.NIGHT_FLOOR * scaled),
        TUNING.MAX_WEIGHT,
      ))
    }
  }

  // 기준 구성의 도시에서 «평일 하루·시간 평균 = 1.0». 화면 위 사람 수와 서버 승객 수가
  // 같은 눈금을 쓰게 하려고 서버와 똑같이 맞춰 둔다.
  const after = TYPES.reduce((acc, t) => acc + mean(out[t].WEEKDAY) * REFERENCE_MIX[t], 0) / REFERENCE_STATIONS
  const fix = 1 / (after || 1)
  for (const type of TYPES) {
    for (const dayType of DAY_TYPES) out[type][dayType] = out[type][dayType].map(v => v * fix)
  }
  return out
}

const cities = Object.fromEntries(
  (Object.keys(profile.cities) as CityKey[]).map(key => [key, tune(profile.cities[key].origin as Table)]),
) as Record<CityKey, Table>

/** 그 시각 그 타입의 역으로 사람이 몰리는 상대 세기 (도시 평균 역 = 1.0 근처) */
export function stationDemandWeight(city: string, type: string, hour: number, weekend: boolean): number {
  const table = cities[city as CityKey] ?? cities[DEFAULT_CITY]
  const curve = table[type as TypeKey] ?? table.RESIDENTIAL
  const h = ((Math.floor(hour) % HOURS) + HOURS) % HOURS
  return curve[weekend ? 'WEEKEND' : 'WEEKDAY'][h]
}

/** 역 타입별 가중치 묶음 — 한 프레임에서 여러 번 뽑을 때 쓴다. */
export function stationDemandWeights(city: string, hour: number, weekend: boolean): Record<string, number> {
  return Object.fromEntries(TYPES.map(t => [t, stationDemandWeight(city, t, hour, weekend)]))
}
