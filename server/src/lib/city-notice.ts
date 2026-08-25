/**
 * 도시 방에 직접 띄우는 수동 공지.
 *
 * 운영자가 스크립트로 publish 하면, 그 도시를 구독 중인 실시간 서버가 받아
 * 접속해 있는 플레이어 화면에 그대로 push 한다(`{ type: 'notice' }`).
 * 모션 캐시와 달리 이건 "조용히 실패해도 되는 캐시"가 아니라서, Redis가 없으면
 * 삼키지 말고 호출부에 알린다 — 안 갔는데 갔다고 보이면 안 된다.
 */
import { getRedisCommandClient } from './redis-client'

export const REDIS_NOTICE_CHANNEL = 'nlt:city-notice'

export type CityNoticeLevel = 'INFO' | 'WARNING'

export type CityNotice = {
  cityId: string
  level: CityNoticeLevel
  message: string
}

export function parseCityNotice(raw: string): CityNotice | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const { cityId, level, message } = parsed as Partial<CityNotice>
  if (typeof cityId !== 'string' || !cityId) return null
  if (typeof message !== 'string' || !message.trim()) return null
  return {
    cityId,
    level: level === 'WARNING' ? 'WARNING' : 'INFO',
    message: message.trim(),
  }
}

/** command 클라이언트는 connect가 끝나야 ready가 된다 — 짧게 사는 CLI를 위해 기다려준다. */
async function waitForCommandClient(timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const client = await getRedisCommandClient()
    if (client) return client
    if (Date.now() >= deadline) return null
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** 공지를 보낸다. 반환값은 받은 실시간 서버 프로세스 수(0이면 아무도 안 듣고 있다는 뜻). */
export async function publishCityNotice(notice: CityNotice, timeoutMs = 5_000): Promise<number> {
  const client = await waitForCommandClient(timeoutMs)
  if (!client) throw new Error('Redis에 연결하지 못했습니다. REDIS_URL을 확인해주세요.')
  return client.publish(REDIS_NOTICE_CHANNEL, JSON.stringify(notice))
}
