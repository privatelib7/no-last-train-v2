/**
 * 게임 시각에 따른 «밤 정도» 0(한낮)~1(한밤).
 *
 * 특정 시각에 뚝 바뀌면 화면이 깜빡인 것처럼 보이므로, 해질녘·동틀녘을 구간으로
 * 두고 그 안에서 smoothstep으로 잇는다(구간 경계에서 변화율도 0이라 이음매가 없다).
 * 게임 하루는 실시간 약 7분이라 해질녘 4시간은 실시간 약 70초에 걸쳐 넘어간다.
 */

/** 해가 지기 시작하는 시각 — 이 전까지는 완전한 낮 */
const DUSK_START = 16.5
/** 완전히 어두워지는 시각 */
const DUSK_END = 20.5
/** 밝아지기 시작하는 시각 — 이 전까지는 완전한 밤 */
const DAWN_START = 4.5
/** 완전히 밝아지는 시각 */
const DAWN_END = 7.5

function smoothstep(t: number): number {
  const x = Math.max(0, Math.min(1, t))
  return x * x * (3 - 2 * x)
}

export function nightFactor(gameHour: number): number {
  // 24를 넘거나 음수인 값이 들어와도 하루 안으로 접는다
  const hour = ((gameHour % 24) + 24) % 24
  if (hour >= DUSK_END || hour < DAWN_START) return 1
  if (hour >= DAWN_END && hour < DUSK_START) return 0
  if (hour < DAWN_END) return 1 - smoothstep((hour - DAWN_START) / (DAWN_END - DAWN_START))
  return smoothstep((hour - DUSK_START) / (DUSK_END - DUSK_START))
}
