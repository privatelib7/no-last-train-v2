// 도시별 맵 지오메트리 — 손으로 그리지 않는다. build-map-profile.mjs가 실측 공공데이터에서
// 구운 것을 읽기만 한다. 원본 JSON은 `npm run data:map`이 써 준다.
//
// 구역은 256×256 격자에 «한 칸 한 유형»으로 배정한 뒤 윤곽을 뽑은 것이라 서로 겹치지
// 않는다(경계는 닿는다). 빌드가 굽자마자 65536칸을 다시 세서 확인하고,
// client/test/map-profile.test.ts가 커밋된 데이터에 대해 다시 확인한다.

import type { StationType } from './api/game'
import profile from './data/map-profile.json'

/** 게임의 5개 역 타입 + 녹지·산지 */
export type DistrictKind = StationType | 'GREEN'

export type District = {
  /** 그 안에서 가장 붐비는 역에서 딴 이름 (역이 없으면 자치구 이름) */
  name: string
  kind: DistrictKind
  /** 'M x y L x y … Z' 절대좌표. 곡선·상대명령 없음 — 테스트가 이 형식에 기댄다 */
  d: string
  label: [number, number]
}

export type CityMapDef = {
  key: string
  name: string
  /** 섬·내수면은 같은 d 안의 서브패스다 → fill-rule="evenodd"로 그려야 구멍이 뚫린다 */
  coastline: string
  water: string[]
  /** 낮은 밴드부터. 겹쳐 그리면 높은 곳이 저절로 진해진다 */
  reliefBands: Array<{ minM: number; d: string }>
  contours: Array<{ elevM: number; d: string }>
  districts: District[]
  guLabels: Array<{ name: string; at: [number, number] }>
  /** 256×256 비트마스크 조회. 맵 밖이거나 NaN이면 false */
  isLand: (x: number, y: number) => boolean
}

const MASK = 256
const CELL = MASK / 100

function isLandFrom(base64: string) {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return (x: number, y: number) => {
    // 실수 좌표에서 걸러야 한다. 정수 인덱스로 자른 뒤 검사하면 (-0.5 * 2.56) | 0 === 0이라
    // 맵 왼쪽 바깥이 유효 칸으로 둔갑한다. 이 형태로 쓰면 NaN도 함께 걸린다.
    if (!(x >= 0 && x < 100 && y >= 0 && y < 100)) return false
    const bit = ((y * CELL) | 0) * MASK + ((x * CELL) | 0)
    return (bytes[bit >> 3] & (128 >> (bit & 7))) !== 0
  }
}

// 모듈 로드 때 한 번만 만든다. getCityMap이 매번 «같은 객체»를 돌려줘야
// GamePage의 useMemo와 memo(LiveTransitLayer)가 부모 리렌더에서 살아남는다.
const CITY_MAPS: Record<string, CityMapDef> = Object.fromEntries(
  Object.entries(profile.cities).map(([key, city]) => [key, {
    key,
    name: city.name,
    coastline: city.coastline,
    water: city.water,
    reliefBands: city.reliefBands,
    contours: city.contours,
    districts: city.districts as District[],
    guLabels: city.guLabels as Array<{ name: string; at: [number, number] }>,
    isLand: isLandFrom(city.landMask),
  }]),
)

export function getCityMap(key: string | null | undefined): CityMapDef {
  return CITY_MAPS[key ?? ''] ?? CITY_MAPS.BUSAN
}
