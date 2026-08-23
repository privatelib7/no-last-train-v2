import assert from 'node:assert/strict'
import test from 'node:test'
import { nightFactor } from '../src/day-night'

test('한낮은 0, 한밤은 1이고 해질녘·동틀녘에서만 움직인다', () => {
  assert.equal(nightFactor(12), 0)
  assert.equal(nightFactor(9), 0)
  assert.equal(nightFactor(23), 1)
  assert.equal(nightFactor(3), 1)

  // 해질녘 중간은 중간값
  assert.ok(nightFactor(18.5) > 0.4 && nightFactor(18.5) < 0.6)
  // 동틀녘 중간도 중간값
  assert.ok(nightFactor(6) > 0.4 && nightFactor(6) < 0.6)
})

test('해질녘에는 단조 증가, 동틀녘에는 단조 감소한다', () => {
  const at = (h: number) => nightFactor(h)
  for (let h = 16.5; h < 20.5; h += 0.25) assert.ok(at(h + 0.25) >= at(h), `해질녘 ${h}`)
  for (let h = 4.5; h < 7.5; h += 0.25) assert.ok(at(h + 0.25) <= at(h), `동틀녘 ${h}`)
})

test('구간 경계에서 값이 튀지 않는다', () => {
  // 경계 직전/직후 차이가 아주 작아야 «갑자기 어두워짐»이 없다
  for (const boundary of [4.5, 7.5, 16.5, 20.5]) {
    const gap = Math.abs(nightFactor(boundary + 0.01) - nightFactor(boundary - 0.01))
    assert.ok(gap < 0.01, `${boundary}시 경계에서 ${gap} 만큼 튐`)
  }
})

test('하루를 벗어난 시각도 하루 안으로 접는다', () => {
  assert.equal(nightFactor(24 + 12), nightFactor(12))
  assert.equal(nightFactor(-1), nightFactor(23))
})
