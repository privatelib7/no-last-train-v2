// 도시별 실시간 마우스 커서 위치를 저장하는 인메모리 프레즌스 스토어.
// Next.js는 라우트 핸들러를 청크별로 번들해서 모듈 scope Map이 복제될 수 있다.
// 반드시 globalThis에 붙여 GET/POST/DELETE가 같은 저장소를 보게 한다.

type CursorEntry = {
  playerId: string
  nickname: string
  x: number
  y: number
  color: string
  updatedAt: number
}

export type CursorSnapshot = Omit<CursorEntry, 'updatedAt'> & { updatedAt: string }

const CURSOR_TTL_MS = 5000

const CURSOR_COLORS = ['#ff6f91', '#4fc9a8', '#5b8cf2', '#ffb648', '#a77dfb', '#3ecbd0', '#f4886b'] as const

const globalForCursors = globalThis as unknown as {
  __nltCursorsByCity?: Map<string, Map<string, CursorEntry>>
}

function store(): Map<string, Map<string, CursorEntry>> {
  if (!globalForCursors.__nltCursorsByCity) {
    globalForCursors.__nltCursorsByCity = new Map()
  }
  return globalForCursors.__nltCursorsByCity
}

function colorForPlayer(playerId: string): string {
  let hash = 0
  for (let i = 0; i < playerId.length; i++) {
    hash = (hash * 31 + playerId.charCodeAt(i)) >>> 0
  }
  return CURSOR_COLORS[hash % CURSOR_COLORS.length]
}

function pruneStale(cityCursors: Map<string, CursorEntry>, now: number) {
  for (const [playerId, entry] of cityCursors) {
    if (now - entry.updatedAt > CURSOR_TTL_MS) cityCursors.delete(playerId)
  }
}

export function upsertCursor(cityId: string, playerId: string, nickname: string, x: number, y: number) {
  const now = Date.now()
  const cursorsByCity = store()
  let cityCursors = cursorsByCity.get(cityId)
  if (!cityCursors) {
    cityCursors = new Map()
    cursorsByCity.set(cityId, cityCursors)
  }
  pruneStale(cityCursors, now)
  cityCursors.set(playerId, { playerId, nickname, x, y, color: colorForPlayer(playerId), updatedAt: now })
}

export function removeCursor(cityId: string, playerId: string) {
  store().get(cityId)?.delete(playerId)
}

function toSnapshot(entry: CursorEntry): CursorSnapshot {
  return { ...entry, updatedAt: new Date(entry.updatedAt).toISOString() }
}

export function listOtherCursors(cityId: string, excludePlayerId: string): CursorSnapshot[] {
  const cityCursors = store().get(cityId)
  if (!cityCursors) return []
  pruneStale(cityCursors, Date.now())
  return [...cityCursors.values()]
    .filter(entry => entry.playerId !== excludePlayerId)
    .map(toSnapshot)
}

/** 방금 upsert한(또는 이미 있는) 한 명의 스냅샷 — 실시간 커서 브로드캐스트 페이로드용 */
export function getCursor(cityId: string, playerId: string): CursorSnapshot | null {
  const entry = store().get(cityId)?.get(playerId)
  return entry ? toSnapshot(entry) : null
}

/**
 * TTL을 넘긴 항목을 지우고 "누가 지워졌는지" 돌려준다. HTTP 폴링 시절엔 매 요청마다
 * pruneStale이 곁다리로 불려서 자연히 청소됐지만, WebSocket push는 이벤트 기반이라
 * 아무도 그 방에 커서를 보내지 않으면 죽은 항목이 안 지워진다 — realtime-server가
 * 이걸 주기적으로 불러 하트비트(2초)+TTL(5초)로 방치된 접속을 정리하고, 지워진
 * playerId만큼 다른 구독자에게 "떠났다"를 알려준다.
 */
export function pruneAndListRemoved(cityId: string): string[] {
  const cityCursors = store().get(cityId)
  if (!cityCursors) return []
  const now = Date.now()
  const removed: string[] = []
  for (const [playerId, entry] of cityCursors) {
    if (now - entry.updatedAt > CURSOR_TTL_MS) {
      cityCursors.delete(playerId)
      removed.push(playerId)
    }
  }
  return removed
}
