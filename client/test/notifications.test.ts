import assert from 'node:assert/strict'
import test from 'node:test'
import { newlyJoinedPlayers } from '../src/lib/notifications'

test('첫 프레즌스 기준선 이후 새로 들어온 동료만 찾는다', () => {
  const known = new Set(['player-a', 'player-b'])
  const next = [
    { playerId: 'player-b', nickname: '기존 동료' },
    { playerId: 'player-c', nickname: '새 동료' },
  ]

  assert.deepEqual(newlyJoinedPlayers(known, next), [next[1]])
})

test('나갔다가 다시 들어온 동료는 현재 기준선에서 새 접속으로 본다', () => {
  const activeAfterLeave = new Set<string>()
  const rejoined = [{ playerId: 'player-a', nickname: '다시 온 동료' }]

  assert.deepEqual(newlyJoinedPlayers(activeAfterLeave, rejoined), rejoined)
})
