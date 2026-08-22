/**
 * 서버 motion 좌표를 목표로 순항 속도로 따라간다.
 * 라이브 엔진이 100ms마다 권위 있는 x/y를 보내므로, 목표에 닿으면 그 자리에
 * 머문다. 예전처럼 마지막 속도로 미끄러지면(coast) 패킷보다 앞서갔다가
 * 되돌아와 제자리에서 진동했다.
 */

export type SmoothPoint = { x: number; y: number }

export type LastMoveState = {
  lastMs: number
}

const SNAP_MAP_UNITS = 40
/** 목표에 사실상 도착으로 보는 거리 */
const AT_TARGET_UNITS = 0.08

export function resolveSmoothVehiclePosition(
  vehicleId: string,
  target: SmoothPoint | null,
  nowMs: number,
  smoothRef: Map<string, SmoothPoint>,
  lastMoveRef: Map<string, LastMoveState>,
  cruiseSpeed = 1,
  gameMinutesPerWallSecond = 10 / 3,
  forceSnap = false,
): SmoothPoint | null {
  if (!target) {
    smoothRef.delete(vehicleId)
    lastMoveRef.delete(vehicleId)
    return null
  }

  const prev = smoothRef.get(vehicleId)
  const last = lastMoveRef.get(vehicleId)
  const unitsPerWallSecond = Math.max(0.2, cruiseSpeed) * Math.max(0.5, gameMinutesPerWallSecond)

  if (!prev || !last || forceSnap) {
    smoothRef.set(vehicleId, target)
    lastMoveRef.set(vehicleId, { lastMs: nowMs })
    return target
  }

  const dtSec = Math.max(0, (nowMs - last.lastMs) / 1000)
  const dist = Math.hypot(target.x - prev.x, target.y - prev.y)

  if (dist > SNAP_MAP_UNITS || dtSec <= 0) {
    smoothRef.set(vehicleId, target)
    lastMoveRef.set(vehicleId, { lastMs: nowMs })
    return target
  }

  if (dist > AT_TARGET_UNITS) {
    const maxStep = unitsPerWallSecond * dtSec
    const ratio = Math.min(1, maxStep / dist)
    const current = {
      x: prev.x + (target.x - prev.x) * ratio,
      y: prev.y + (target.y - prev.y) * ratio,
    }
    smoothRef.set(vehicleId, current)
    lastMoveRef.set(vehicleId, { lastMs: nowMs })
    return current
  }

  smoothRef.set(vehicleId, target)
  lastMoveRef.set(vehicleId, { lastMs: nowMs })
  return target
}
