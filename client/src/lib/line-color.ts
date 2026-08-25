// 예전에는 노선 색상을 RED/BLUE/GREEN/YELLOW/PURPLE 같은 고정 이름으로 저장했다.
// 지금은 임의의 색상 코드(#RRGGBB)를 저장하지만, 마이그레이션 전 데이터나 옛 기본값이
// 남아 있을 수 있어 이 맵으로 헥스로 변환해 둔다. 이미 헥스면 그대로 통과시킨다.
const LEGACY_LINE_COLOR_HEX: Record<string, string> = {
  RED: '#E9783C',
  BLUE: '#3F8EDB',
  GREEN: '#55A96A',
  YELLOW: '#E1B735',
  PURPLE: '#8E6CC1',
}

export function resolveLineColor(color: string): string {
  return LEGACY_LINE_COLOR_HEX[color] ?? color
}

// 새 노선에 우선 배정하는 기본 팔레트 — 서로 뚜렷이 구분되는 색 20가지.
// 서버(server/src/lib/line-color.ts)와 반드시 같은 순서로 유지한다.
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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

export function hsvToHex(h: number, s: number, v: number): string {
  const hue = ((h % 360) + 360) % 360
  const sat = clamp01(s)
  const val = clamp01(v)
  const c = val * sat
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = val - c
  let r = 0
  let g = 0
  let b = 0
  if (hue < 60) [r, g, b] = [c, x, 0]
  else if (hue < 120) [r, g, b] = [x, c, 0]
  else if (hue < 180) [r, g, b] = [0, c, x]
  else if (hue < 240) [r, g, b] = [0, x, c]
  else if (hue < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const toHex = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase()
}

export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16) / 255
  const g = parseInt(clean.slice(2, 4), 16) / 255
  const b = parseInt(clean.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  const s = max === 0 ? 0 : d / max
  const v = max
  return { h, s, v }
}
