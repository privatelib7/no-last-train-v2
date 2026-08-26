import type { CityMotionSnapshot } from './game'
import type { CityState } from './game'

/**
 * 도시 상태·차량 위치를 서버가 밀어주는(push) WebSocket 연결.
 * 예전의 /city(2500ms)·/motion(500ms) HTTP 폴링을 대체한다.
 * 동료 커서(마우스 위치)도 이 연결 위로 같이 오간다 — 별도 REST 폴링 없이
 * 받은 즉시 서버가 같은 방 구독자에게 전달해준다(server/scripts/realtime-server.ts).
 */

export type RemoteCursor = {
  playerId: string
  nickname: string
  x: number
  y: number
  color: string
  updatedAt: string
}

const API_BASE = import.meta.env.VITE_API_URL ?? ''

function wsUrl(): string {
  if (API_BASE) {
    // https://example.com -> wss://example.com/ws, http:// -> ws://
    return API_BASE.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws'
  }
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}/ws`
}

type RealtimeHandlers = {
  onMotion: (snapshot: CityMotionSnapshot) => void
  onCity: (state: CityState) => void
  /** 구독 직후 한 번 — 이미 그 방에 있던 사람들의 커서 전체 목록 */
  onCursorInit?: (cursors: RemoteCursor[]) => void
  /** 누군가 움직이거나(50ms 스로틀) 하트비트(2초)를 보낼 때마다 — 한 명분만 */
  onCursor?: (cursor: RemoteCursor) => void
  /** 누군가 방을 나갔을 때(닫기/새로고침/TTL 만료) */
  onCursorLeave?: (playerId: string) => void
  onError?: (message: string) => void
}

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 8000

export type RealtimeConnection = {
  close: () => void
  /** 내 커서 위치(뷰포트 % 0~100)를 즉시 보낸다 — 호출부에서 스로틀을 책임진다 */
  sendCursor: (x: number, y: number) => void
}

/** 도시 하나를 구독한다. cityId나 token이 바뀌면 새로 connectRealtime을 불러야 한다. */
export function connectRealtime(
  cityId: string,
  playerToken: string | undefined,
  handlers: RealtimeHandlers,
): RealtimeConnection {
  let closed = false
  let ws: WebSocket | null = null
  let reconnectAttempt = 0
  let reconnectTimer: number | null = null

  const subscribe = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'subscribe', cityId, playerToken: playerToken ?? '' }))
  }

  const scheduleReconnect = () => {
    if (closed) return
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempt)
    reconnectAttempt += 1
    reconnectTimer = window.setTimeout(connect, delay)
  }

  const connect = () => {
    if (closed) return
    const socket = new WebSocket(wsUrl())
    ws = socket

    socket.onopen = () => {
      reconnectAttempt = 0
      subscribe()
    }

    socket.onmessage = event => {
      let msg: unknown
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object') return
      const { type, payload, message } = msg as { type?: string; payload?: unknown; message?: string }
      if (type === 'motion' && payload) handlers.onMotion(payload as CityMotionSnapshot)
      else if (type === 'city' && payload) handlers.onCity(payload as CityState)
      else if (type === 'cursor-init' && payload) handlers.onCursorInit?.(payload as RemoteCursor[])
      else if (type === 'cursor' && payload) handlers.onCursor?.(payload as RemoteCursor)
      else if (type === 'cursor-leave' && payload) {
        const { playerId } = payload as { playerId?: string }
        if (playerId) handlers.onCursorLeave?.(playerId)
      } else if (type === 'error' && message) handlers.onError?.(message)
    }

    socket.onclose = () => {
      if (ws === socket) ws = null
      scheduleReconnect()
    }

    socket.onerror = () => {
      socket.close()
    }
  }

  connect()

  return {
    close: () => {
      closed = true
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer)
      ws?.close()
      ws = null
    },
    sendCursor: (x: number, y: number) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify({ type: 'cursor', x, y }))
    },
  }
}
