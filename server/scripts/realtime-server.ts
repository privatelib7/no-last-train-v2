/**
 * 실시간 상태(차량 위치·틱, 도시 전체 상태) 전용 WebSocket 서버.
 *
 * 차량 좌표는 DB 틱(3초)과 분리해 자주 push 한다.
 * - motion push (~100ms): 캐시된 상태에서 벽시계 preview로 x/y만 계산 (DB I/O 없음)
 * - motion sync (~400ms): 밀린 틱을 따라잡고 PostgreSQL에서 베이스를 다시 읽는다
 * - city state (~2500ms): 잔고·대기인원 등 무거운 스냅샷
 *
 * Redis는 motion 베이스의 보조 캐시 + pub/sub 계층이다(PostgreSQL 대체 아님):
 * sync가 PostgreSQL에서 읽을 때마다 Redis에도 채워두고 채널로 publish하므로,
 * 나중에 이 WS 서버를 여러 인스턴스로 늘려도 각 인스턴스가 PostgreSQL을 각자
 * 두드리지 않고 Redis만으로 최신 상태를 즉시 받아 push할 수 있다. Redis가
 * 죽어도 sync 루프는 그대로 PostgreSQL에서 읽으므로 동작에는 지장이 없다.
 *
 *   npx tsx scripts/realtime-server.ts
 */
import { createServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { resolvePlayerByToken, cityExists } from '../src/lib/access'
import { syncCityClock, tickRecentlyActiveCities } from '../src/lib/simulation'
import {
  buildCityMotionSnapshot,
  invalidateCityMotionCache,
  loadCityMotionBase,
  refreshCityMotionBase,
  renderCityMotionSnapshot,
  setCachedMotionBase,
  REDIS_MOTION_UPDATE_CHANNEL,
  type CityMotionBase,
} from '../src/lib/city-motion'
import {
  createLiveCityEngine,
  advanceFrame,
  runEconomicTickAndFlush,
  flushLiveCityEngine,
  refreshLiveEngineTopology,
  renderLiveMotionSnapshot,
  warmLocalMotionCache,
  publishLiveMotionBase,
  type LiveCityEngine,
} from '../src/lib/live-city-engine'
import { getRedisSubscriberClient } from '../src/lib/redis-client'
import { buildCityStateSnapshot } from '../src/lib/city-state'
import { upsertCursor, removeCursor, listOtherCursors, getCursor, pruneAndListRemoved } from '../src/lib/cursor-presence'
import { SIM } from '../src/types/game'

const PORT = Number(process.env.REALTIME_PORT ?? 3012)
/** 좌표 push — 캐시 렌더만 하므로 짧게 가져도 DB를 때리지 않는다 */
const MOTION_PUSH_MS = 100
/** 틱 따라잡기 + 모션 베이스 갱신 (push보다 드물게, 캐시는 비우지 않고 교체) */
const MOTION_SYNC_MS = 400
const CITY_INTERVAL_MS = 2500
const HEARTBEAT_INTERVAL_MS = SIM.LIVE_TICK_MS
const WS_CATCHUP_MAX_TICKS = 20
const SYNC_CONCURRENCY = 4
/** 클라이언트 하트비트(2초)보다 넉넉히 자주 돌아 TTL(cursor-presence.ts, 5초)을 넘긴
 *  방치된 커서를 청소한다 — WS는 이벤트 기반이라 아무도 안 움직이면 저절로 안 지워진다. */
const CURSOR_PRUNE_MS = 2000

/** 라이브 엔진 경제 틱(승객 생성/정책/SimTick 기록 + DB flush) 주기 — 기존 "경제 틱" 주기와 동일 */
const ECONOMIC_TICK_MS = SIM.LIVE_TICK_MS

type ConnState = { cityId: string | null; playerId: string | null; nickname: string | null }

const connState = new Map<WebSocket, ConnState>()
const citySubscribers = new Map<string, Set<WebSocket>>()
/** 구독자가 있는 도시의 인메모리 라이브 엔진 — 100ms 위치/탑승/매출, ~3초 DB flush를 스스로 관리한다 */
const liveEngines = new Map<string, LiveCityEngine>()
const liveEngineBootstrapping = new Set<string>()

async function ensureLiveEngine(cityId: string) {
  if (liveEngines.has(cityId) || liveEngineBootstrapping.has(cityId)) return
  liveEngineBootstrapping.add(cityId)
  try {
    const engine = await createLiveCityEngine(cityId)
    // 부트스트랩 도중 마지막 구독자가 나갔으면 굳이 엔진을 유지할 필요 없다.
    if (engine && citySubscribers.get(cityId)?.size) {
      liveEngines.set(cityId, engine)
    }
  } catch (err) {
    console.error(`[realtime] live engine bootstrap failed for ${cityId}`, err)
  } finally {
    liveEngineBootstrapping.delete(cityId)
  }
}

async function teardownLiveEngine(cityId: string) {
  const engine = liveEngines.get(cityId)
  if (!engine) return
  liveEngines.delete(cityId)
  try {
    await flushLiveCityEngine(engine)
  } catch (err) {
    console.error(`[realtime] live engine flush-on-teardown failed for ${cityId}`, err)
  }
}

function subscribersFor(cityId: string): Set<WebSocket> {
  let set = citySubscribers.get(cityId)
  if (!set) {
    set = new Set()
    citySubscribers.set(cityId, set)
  }
  return set
}

function send(ws: WebSocket, message: unknown) {
  if (ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify(message))
}

/** 같은 방(cityId) 구독자 전원에게, excludeWs가 있으면 그 소켓만 빼고 보낸다 */
function broadcastToCity(cityId: string, message: unknown, excludeWs?: WebSocket) {
  const sockets = citySubscribers.get(cityId)
  if (!sockets) return
  for (const ws of sockets) {
    if (ws === excludeWs) continue
    send(ws, message)
  }
}

function unsubscribe(ws: WebSocket) {
  const state = connState.get(ws)
  if (!state?.cityId) return
  const { cityId, playerId } = state
  const set = citySubscribers.get(cityId)
  set?.delete(ws)
  if (set && set.size === 0) {
    citySubscribers.delete(cityId)
    invalidateCityMotionCache(cityId)
    void teardownLiveEngine(cityId)
  }
  state.cityId = null
  // 커서도 같이 정리한다 — 안 그러면 나간 사람 커서가 다른 사람 화면에 얼어붙은 채 남는다.
  if (playerId) {
    removeCursor(cityId, playerId)
    broadcastToCity(cityId, { type: 'cursor-leave', payload: { playerId } })
  }
}

function subscribedCityIds(): string[] {
  return [...citySubscribers.entries()]
    .filter(([, sockets]) => sockets.size > 0)
    .map(([cityId]) => cityId)
}

async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  if (items.length === 0) return
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index]
      index += 1
      await fn(current)
    }
  })
  await Promise.all(workers)
}

async function sendMotionTo(ws: WebSocket, cityId: string) {
  try {
    // 구독 직후는 최신 DB를 강제 로드해 캐시를 데운다.
    await loadCityMotionBase(cityId)
    const snapshot = await buildCityMotionSnapshot(cityId)
    if (snapshot) send(ws, { type: 'motion', payload: snapshot })
  } catch (err) {
    console.error(`[realtime] initial motion send failed for ${cityId}`, err)
  }
}

async function sendCityStateTo(ws: WebSocket, cityId: string, playerId: string | null) {
  try {
    const snapshot = await buildCityStateSnapshot(cityId, playerId)
    if (snapshot) send(ws, { type: 'city', payload: snapshot })
  } catch (err) {
    console.error(`[realtime] initial city send failed for ${cityId}`, err)
  }
}

function pushMotionSnapshotToCity(cityId: string, snapshot: ReturnType<typeof renderCityMotionSnapshot>) {
  const sockets = citySubscribers.get(cityId)
  if (!sockets || sockets.size === 0) return
  const message = JSON.stringify({ type: 'motion', payload: snapshot })
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(message)
  }
}

/**
 * 라이브 엔진이 있는 도시는 그 자리에서 100ms만큼 전진(위치·탑승·매출 확정)시키고
 * 바로 렌더해서 push한다 — DB 호출 없음. 엔진이 아직 없는(부트스트랩 중이거나 막 구독된)
 * 도시는 기존처럼 캐시 기준 프리뷰 좌표만 밀어준다.
 */
async function broadcastMotionPush() {
  const cityIds = subscribedCityIds()
  const now = Date.now()
  await mapPool(cityIds, 8, async cityId => {
    if (!citySubscribers.get(cityId)?.size) return
    try {
      const engine = liveEngines.get(cityId)
      if (engine) {
        advanceFrame(engine, now)
        const snapshot = renderLiveMotionSnapshot(engine, now)
        pushMotionSnapshotToCity(cityId, snapshot)
        warmLocalMotionCache(engine, now)
        return
      }
      const snapshot = await buildCityMotionSnapshot(cityId)
      if (snapshot) pushMotionSnapshotToCity(cityId, snapshot)
    } catch (err) {
      console.error(`[realtime] motion push failed for ${cityId}`, err)
    }
  })
}

/**
 * Redis pub/sub으로 다른 곳(이 프로세스의 sync 루프 포함)에서 갱신된 motion 베이스가
 * 도착하면, 다음 100ms 주기를 기다리지 않고 바로 렌더해서 밀어준다 — sync/구독 직후처럼
 * 상태가 막 바뀐 순간의 체감 지연을 줄인다. 구독자가 없는 도시는 무시해 메모리를 아낀다.
 */
function subscribeMotionUpdates() {
  const sub = getRedisSubscriberClient()
  sub.subscribe(REDIS_MOTION_UPDATE_CHANNEL).catch(err => {
    console.error('[realtime] redis subscribe failed (계속 폴링 기반으로 동작)', err.message)
  })
  sub.on('message', (_channel, raw) => {
    let base: CityMotionBase
    try {
      base = JSON.parse(raw) as CityMotionBase
    } catch {
      return
    }
    if (!citySubscribers.get(base.cityId)?.size) return
    // 라이브 엔진이 이미 100ms 권위 좌표를 밀고 있으면 DB/프리뷰 스냅샷으로
    // 화면을 되돌리지 않는다. 되돌리면 차량이 잠깐 뒤로 갔다가 다시 맞춰진다.
    if (liveEngines.has(base.cityId)) return
    setCachedMotionBase(base)
    try {
      pushMotionSnapshotToCity(base.cityId, renderCityMotionSnapshot(base))
    } catch (err) {
      console.error(`[realtime] redis-triggered push failed for ${base.cityId}`, err)
    }
  })
}

/**
 * 틱을 따라잡고 모션 베이스를 원자적으로 교체한다(push 중 캐시 공백 없음).
 * 라이브 엔진이 있는 도시는 스스로 경제 틱을 굴리므로 틱 따라잡기는 필요 없지만,
 * 노선 건설·역 건설·차량 배차 같은 액션은 별 프로세스(nlt-server)가 DB에 직접 쓰고
 * 엔진에 알려주는 채널이 없다 — 그래서 같은 주기로 구조(노선/역/차량 목록)만 다시
 * 읽어 반영한다. 이게 없으면 방금 만든 노선/방금 배차한 차량이 엔진 재부트(=페이지
 * 새로고침으로 재구독) 전까지 안 움직인다.
 */
async function broadcastMotionSync() {
  const cityIds = subscribedCityIds()
  await mapPool(cityIds, SYNC_CONCURRENCY, async cityId => {
    try {
      const engine = liveEngines.get(cityId)
      if (engine) {
        await refreshLiveEngineTopology(engine)
        return
      }
      await syncCityClock(cityId, WS_CATCHUP_MAX_TICKS)
      await refreshCityMotionBase(cityId)
    } catch (err) {
      console.error(`[realtime] motion sync failed for ${cityId}`, err)
    }
  })
}

async function broadcastCityState() {
  const cityIds = subscribedCityIds()
  await mapPool(cityIds, SYNC_CONCURRENCY, async cityId => {
    const sockets = citySubscribers.get(cityId)
    if (!sockets || sockets.size === 0) return
    try {
      // 건설/배차 반영: 캐시를 비우지 않고 새 베이스로 교체한 뒤 city 상태를 보낸다.
      // 라이브 엔진이 있는 도시는 건드리지 않는다 — DB는 최대 ~3초 지연될 수 있어
      // 여기서 다시 읽으면 이미 100ms 프레임으로 앞서 있는 캐시를 오히려 되돌리게 된다.
      if (!liveEngines.has(cityId)) await refreshCityMotionBase(cityId)
      const snapshot = await buildCityStateSnapshot(cityId, null)
      if (!snapshot) return
      for (const ws of sockets) {
        if (ws.readyState !== WebSocket.OPEN) continue
        const playerId = connState.get(ws)?.playerId ?? null
        const isOwner = playerId != null && snapshot.city.ownerPlayerId === playerId
        send(ws, { type: 'city', payload: { ...snapshot, isOwner } })
      }
    } catch (err) {
      console.error(`[realtime] city broadcast failed for ${cityId}`, err)
    }
  })
}

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
    return
  }
  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ server: httpServer, path: '/ws' })

wss.on('connection', ws => {
  connState.set(ws, { cityId: null, playerId: null, nickname: null })

  ws.on('message', async raw => {
    let msg: unknown
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    const { type } = msg as { type?: string }

    if (type === 'subscribe') {
      const { cityId, playerToken } = msg as { cityId?: string; playerToken?: string }
      if (!cityId || typeof cityId !== 'string') return
      if (!playerToken || typeof playerToken !== 'string') {
        send(ws, { type: 'error', message: '로그인이 필요합니다.' })
        return
      }
      const player = await resolvePlayerByToken(playerToken)
      if (!player) {
        send(ws, { type: 'error', message: '세션이 만료되었습니다. 다시 로그인해주세요.' })
        return
      }
      if (!(await cityExists(cityId))) {
        send(ws, { type: 'error', message: '도시를 찾을 수 없습니다.' })
        return
      }
      unsubscribe(ws)
      const nickname = player.nickname ?? player.username ?? '플레이어'
      connState.set(ws, { cityId, playerId: player.id, nickname })
      subscribersFor(cityId).add(ws)
      void sendMotionTo(ws, cityId)
      void sendCityStateTo(ws, cityId, player.id)
      void ensureLiveEngine(cityId)
      // 이미 그 방에 있던 사람들의 커서를 한 번에 보내준다 — 각각을 "방금 접속"으로
      // 잘못 알리지 않도록, 개별 브로드캐스트(type: 'cursor')와 메시지 타입을 분리한다.
      send(ws, { type: 'cursor-init', payload: listOtherCursors(cityId, player.id) })
      return
    }

    if (type === 'unsubscribe') {
      unsubscribe(ws)
      return
    }

    if (type === 'cursor') {
      const state = connState.get(ws)
      if (!state?.cityId || !state.playerId) return
      const { x, y } = msg as { x?: unknown; y?: unknown }
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return
      const clampedX = Math.max(0, Math.min(100, x))
      const clampedY = Math.max(0, Math.min(100, y))
      const nickname = state.nickname ?? '플레이어'
      upsertCursor(state.cityId, state.playerId, nickname, clampedX, clampedY)
      const snapshot = getCursor(state.cityId, state.playerId)
      // 타이머 없이, 받은 즉시 같은 방 나머지 구독자에게만 전달한다(보낸 사람 제외).
      if (snapshot) broadcastToCity(state.cityId, { type: 'cursor', payload: snapshot }, ws)
      return
    }
  })

  ws.on('close', () => {
    unsubscribe(ws)
    connState.delete(ws)
  })

  ws.on('error', () => {
    unsubscribe(ws)
    connState.delete(ws)
  })
})

subscribeMotionUpdates()

let motionPushRunning = false
setInterval(() => {
  if (motionPushRunning) return
  motionPushRunning = true
  broadcastMotionPush()
    .catch(err => console.error('[realtime] broadcastMotionPush failed', err))
    .finally(() => { motionPushRunning = false })
}, MOTION_PUSH_MS)

let motionSyncRunning = false
setInterval(() => {
  if (motionSyncRunning) return
  motionSyncRunning = true
  broadcastMotionSync()
    .catch(err => console.error('[realtime] broadcastMotionSync failed', err))
    .finally(() => { motionSyncRunning = false })
}, MOTION_SYNC_MS)

let cityRunning = false
setInterval(() => {
  if (cityRunning) return
  cityRunning = true
  broadcastCityState()
    .catch(err => console.error('[realtime] broadcastCityState failed', err))
    .finally(() => { cityRunning = false })
}, CITY_INTERVAL_MS)

// 커서는 이벤트 기반(받은 즉시 전달)이라 이 타이머가 그 자체를 대체하지 않는다 —
// 오직 하트비트가 끊긴(탭 강제종료 등 close 이벤트 없이 사라진) 방치 커서만 청소한다.
setInterval(() => {
  for (const cityId of subscribedCityIds()) {
    for (const playerId of pruneAndListRemoved(cityId)) {
      broadcastToCity(cityId, { type: 'cursor-leave', payload: { playerId } })
    }
  }
}, CURSOR_PRUNE_MS)

/**
 * 라이브 엔진의 "경제 틱" — 승객 생성/정책 평가/SimTick 기록 + 누적된 차량·승객·잔고
 * 변경분을 DB에 배치 flush한다. 기존 3초 경제 틱과 같은 주기, 대신 여기서는 위치·탑승이
 * 이미 100ms 프레임에서 확정돼 있으므로 그 나머지만 처리한다.
 */
let economicTickRunning = false
setInterval(() => {
  if (economicTickRunning) return
  economicTickRunning = true
  const now = Date.now()
  const engines = [...liveEngines.entries()]
  Promise.all(engines.map(([cityId, engine]) =>
    runEconomicTickAndFlush(engine)
      .then(() => publishLiveMotionBase(engine, now))
      .catch(err => console.error(`[realtime] economic tick failed for ${cityId}`, err)),
  ))
    .catch(err => console.error('[realtime] economic tick batch failed', err))
    .finally(() => { economicTickRunning = false })
}, ECONOMIC_TICK_MS)

let heartbeatRunning = false
setInterval(() => {
  if (heartbeatRunning) return
  heartbeatRunning = true
  tickRecentlyActiveCities(new Set(liveEngines.keys()))
    .catch(err => console.error('[realtime] heartbeat failed', err))
    .finally(() => { heartbeatRunning = false })
}, HEARTBEAT_INTERVAL_MS)

httpServer.listen(PORT, () => {
  console.log(`[realtime] listening on :${PORT} (ws path /ws, motion push ${MOTION_PUSH_MS}ms, sync ${MOTION_SYNC_MS}ms)`)
})
