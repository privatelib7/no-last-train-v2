// 새 노선에 우선 배정하는 기본 팔레트 — 서로 뚜렷이 구분되는 색 20가지.
// 클라이언트(client/src/lib/line-color.ts)와 반드시 같은 순서로 유지한다.
export const LINE_COLOR_PALETTE = [
  '#E9783C', '#3F8EDB', '#55A96A', '#E1B735', '#8E6CC1',
  '#D14D72', '#3FB6C4', '#C97A2B', '#6BAA3D', '#B0479B',
  '#4C6FD1', '#D9535F', '#2FA37D', '#C9A227', '#7A5CC9',
  '#E0668C', '#3D8F8F', '#A0522D', '#5C9DD5', '#9B59B6',
] as const

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

export function isValidHexColor(value: string): boolean {
  return HEX_COLOR_RE.test(value)
}

export function normalizeHexColor(value: string): string {
  return value.toUpperCase()
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100
  const light = l / 100
  const k = (n: number) => (n + h / 30) % 12
  const a = sat * Math.min(light, 1 - light)
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  const toHex = (x: number) => Math.round(255 * x).toString(16).padStart(2, '0')
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`.toUpperCase()
}

/**
 * 도시 안에서 아직 안 쓰인 색을 골라준다. 기본 팔레트를 먼저 소진하고, 그 이후엔
 * 골든 앵글(137.508°)로 색상환을 돌며 새 색을 계속 만들어내 겹치지 않게 한다.
 */
export function nextAvailableLineColor(existingColors: string[]): string {
  const used = new Set(existingColors.map(normalizeHexColor))
  const preset = LINE_COLOR_PALETTE.find(candidate => !used.has(candidate))
  if (preset) return preset

  let hue = (existingColors.length * 137.508) % 360
  let color = hslToHex(hue, 65, 55)
  let guard = 0
  while (used.has(color) && guard < 1000) {
    hue = (hue + 137.508) % 360
    color = hslToHex(hue, 65, 55)
    guard += 1
  }
  return color
}
