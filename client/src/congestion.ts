// 혼잡한 «구간»을 지도에 보여주기 위한 계산. GamePage에서 떼어 낸 이유는 테스트 때문이다
// (GamePage.tsx는 React가 딸려 와 node:test로 못 부른다 — day-night.ts와 같은 이유).

// «타입만» 가져온다. api/game.ts는 모듈 최상단에서 import.meta.env를 읽어서, 값을
// 하나라도 가져오면 Vite 밖(node:test)에서 이 파일을 부를 수 없게 된다.
import type { Station } from './api/game'

/** 대기 인원 / 수용력. 이 위는 주의 */
export const CONGESTION_WARN = 0.7
/** 이 위는 포화 — 더 못 받는다 */
export const CONGESTION_SATURATED = 1.0

export type CongestedSegment = {
  key: string
  from: Station
  to: Station
  /** 0~1. 양 끝 역 중 더 붐비는 쪽 */
  congestion: number
}

/**
 * 서버는 «구간»의 적재량을 내려주지 않는다 — CityMotionVehicle에 탑승 인원이 없고,
 * 역별 혼잡도(대기 인원 / 수용력, 0~1)만 온다. 그래서 구간 혼잡도를 양 끝 역 중
 * «더 붐비는 쪽»으로 잡는다.
 *
 * 평균이 아니라 최대인 이유: 한쪽 역이 포화면 그 역으로 드나드는 구간 전체가 손봐야 할
 * 구간이다. 평균을 쓰면 한산한 옆 역이 그 사실을 희석해서, 정작 배차를 늘려야 할
 * 노선이 눈에 안 띈다. 최대로 잡으면 포화 역이 자기 양쪽 구간을 함께 물들여
 * 「이 노선의 이 대목」이 통째로 보인다 — 플레이어가 실제로 하는 조치와 단위가 맞는다.
 */
export function congestedSegments(
  orderedStations: Station[],
  congestionOf: Map<string, number>,
  threshold = CONGESTION_WARN,
): CongestedSegment[] {
  const hot: CongestedSegment[] = []
  for (let i = 0; i + 1 < orderedStations.length; i++) {
    const from = orderedStations[i]
    const to = orderedStations[i + 1]
    const congestion = Math.max(congestionOf.get(from.id) ?? 0, congestionOf.get(to.id) ?? 0)
    if (congestion < threshold) continue
    hot.push({ key: `${from.id}-${to.id}`, from, to, congestion })
  }
  return hot
}

// 역 혼잡 링이 쓰는 두 색(.warnRing #e8a13c → .saturatedRing #d64541)을 잇는다.
// 새 색을 만들지 않아야 「주황이면 주의, 빨강이면 포화」라는 기존 약속이 그대로 통한다.
const WARN_RGB = [232, 161, 60]
const SATURATED_RGB = [214, 69, 65]

/** 혼잡도 → 0(주의)~1(포화) 정규값과 그 사이 색 */
export function congestionHeat(congestion: number) {
  const span = CONGESTION_SATURATED - CONGESTION_WARN
  const raw = span > 0 ? (congestion - CONGESTION_WARN) / span : 1
  const t = Math.max(0, Math.min(1, Number.isFinite(raw) ? raw : 0))
  const rgb = WARN_RGB.map((v, i) => Math.round(v + (SATURATED_RGB[i] - v) * t))
  return { t, color: `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})` }
}
