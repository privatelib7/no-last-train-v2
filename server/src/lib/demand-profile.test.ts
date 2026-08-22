import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CITY_KEYS,
  DEMAND_TUNING as TUNING,
  OD_MODEL,
  destinationScore,
  mapDistanceToKm,
  DEFAULT_CITY,
  STATION_TYPE_KEYS,
  dayOfWeekMultiplier,
  dayTypeOf,
  demandMultiplier,
  demandProfileSource,
  destWeight,
  originWeight,
} from './demand-profile'
import profile from '@/data/demand-profile.json'

const HOURS = Array.from({ length: 24 }, (_, h) => h)
const MON = 0
const SAT = 5
// 게임이 도시를 만들 때 쓰는 역 구성 (prisma/seed.ts) — demand-profile.ts의 REFERENCE_MIX와 같다.
const MIX: Record<string, number> = { RESIDENTIAL: 4, COMMERCIAL: 4, TOURIST: 4, INDUSTRIAL: 2, HUB: 2 }
const MIX_TOTAL = Object.values(MIX).reduce((a, b) => a + b, 0)

test('맵 두 곳(서울·부산)의 프로필이 다 들어 있다', () => {
  assert.deepEqual([...CITY_KEYS].sort(), ['BUSAN', 'SEOUL'])
  assert.equal(profile.cities.SEOUL.source.dataset.id, 'OA-12921')
  assert.equal(profile.cities.BUSAN.source.dataset.id, '3057229')
  for (const city of CITY_KEYS) {
    assert.ok(profile.cities[city].source.stationsUsed > 100)
    assert.equal(profile.cities[city].dayOfWeek.length, 7)
    for (const type of STATION_TYPE_KEYS) {
      assert.equal(profile.cities[city].origin[type].WEEKDAY.length, 24)
      assert.equal(profile.cities[city].dest[type].WEEKEND.length, 24)
    }
  }
})

test('모르는 mapKey는 기본 맵으로 떨어진다 — 곡선이 사라지지 않는다', () => {
  assert.equal(demandMultiplier('ATLANTIS', 8, MON), demandMultiplier(DEFAULT_CITY, 8, MON))
  assert.equal(demandProfileSource('ATLANTIS').city, DEFAULT_CITY)
})

for (const city of ['SEOUL', 'BUSAN']) {
  test(`[${city}] 평일 하루 평균 수요 배율이 1.0이다 — 튜닝을 바꿔도 경제 밸런스가 흔들리지 않는다`, () => {
    let total = 0
    for (let day = 0; day < 5; day++) total += HOURS.reduce((acc, h) => acc + demandMultiplier(city, h, day), 0)
    assert.ok(Math.abs(total / (5 * 24) - 1) < 0.02, `평일 평균 ${total / (5 * 24)}`)
  })

  test(`[${city}] 출발 가중치의 역 구성 가중 평균이 도시 곡선과 일치한다 — 이중 계산이 없다`, () => {
    for (const hour of HOURS) {
      const blended = STATION_TYPE_KEYS
        .reduce((acc, t) => acc + originWeight(city, t, hour, MON) * MIX[t], 0) / MIX_TOTAL
      assert.ok(Math.abs(blended - demandMultiplier(city, hour, MON)) < 1e-6, `${hour}시`)
    }
  })

  test(`[${city}] 평일 곡선에 출근·퇴근 봉우리가 서고 새벽엔 가라앉는다`, () => {
    const weekday = HOURS.map(h => demandMultiplier(city, h, MON))
    const peakMorning = Math.max(weekday[7], weekday[8])
    const peakEvening = Math.max(weekday[17], weekday[18])
    const midday = weekday[13]
    const dawn = weekday[3]

    // 아침 봉우리는 도시마다 세기가 다르다 — 서울은 낮의 1.6배, 부산은 1.2배쯤이다.
    // 부산이 완만한 건 통근 외 이용(낮 시간대)이 많아서고, 그 차이는 아래 도시 비교 테스트가 잡는다.
    assert.ok(peakMorning > midday * 1.1, `아침 피크 ${peakMorning} vs 낮 ${midday}`)
    assert.ok(peakMorning > weekday[6] * 1.5, `아침 피크가 출근 직전보다 뚜렷하다`)
    assert.ok(peakEvening > midday * 1.3, `저녁 피크 ${peakEvening} vs 낮 ${midday}`)
    assert.ok(dawn < midday, '새벽이 낮보다 한산하다')
    assert.ok(dawn > 0, '새벽에도 사람이 아주 없지는 않다 — NIGHT_FLOOR')
  })

  test(`[${city}] 주말 곡선에는 출근 피크가 없고 총수요가 평일보다 적다`, () => {
    const weekday = HOURS.reduce((acc, h) => acc + demandMultiplier(city, h, MON), 0)
    const weekend = HOURS.reduce((acc, h) => acc + demandMultiplier(city, h, SAT), 0)
    assert.ok(weekend < weekday, `주말 ${weekend} < 평일 ${weekday}`)

    const sat = HOURS.map(h => demandMultiplier(city, h, SAT))
    const morning = Math.max(sat[7], sat[8])
    const afternoon = Math.max(...sat.slice(13, 19))
    assert.ok(morning < afternoon, `주말 아침 ${morning} < 오후 ${afternoon}`)
  })

  test(`[${city}] 아침엔 주거역이 내보내고 업무역이 받아들인다 — 저녁엔 반대`, () => {
    assert.ok(originWeight(city, 'RESIDENTIAL', 8, MON) > originWeight(city, 'INDUSTRIAL', 8, MON))
    assert.ok(destWeight(city, 'INDUSTRIAL', 8, MON) > destWeight(city, 'RESIDENTIAL', 8, MON))

    assert.ok(originWeight(city, 'INDUSTRIAL', 18, MON) > originWeight(city, 'RESIDENTIAL', 18, MON))
    assert.ok(destWeight(city, 'RESIDENTIAL', 18, MON) > destWeight(city, 'INDUSTRIAL', 18, MON))
  })

  test(`[${city}] 업무·산업역은 주말에 비고 관광역은 덜 빠진다`, () => {
    const drop = (type: string) => originWeight(city, type, 14, SAT) / originWeight(city, type, 14, MON)
    assert.ok(drop('INDUSTRIAL') < drop('TOURIST'), `산업 ${drop('INDUSTRIAL')} < 관광 ${drop('TOURIST')}`)
  })

  test(`[${city}] 어떤 역·시간도 상한을 넘지 않는다 — 배차로 감당 못 하는 구간을 막는다`, () => {
    for (const type of STATION_TYPE_KEYS) {
      for (let day = 0; day < 7; day++) {
        for (const hour of HOURS) {
          const w = originWeight(city, type, hour, day)
          assert.ok(w > 0, `${type} ${day}요일 ${hour}시가 0이다`)
          assert.ok(w <= TUNING.MAX_WEIGHT * 1.2, `${type} ${day}요일 ${hour}시 = ${w}`)
        }
      }
    }
  })

  test(`[${city}] 요일 구분과 요일 배율이 실측을 따른다`, () => {
    assert.equal(dayTypeOf(4), 'WEEKDAY')
    assert.equal(dayTypeOf(5), 'WEEKEND')
    assert.equal(dayTypeOf(7), 'WEEKDAY')  // 다음 주 월요일

    // 실측: 금요일이 평일 중 가장 붐비고, 토요일이 일요일보다 붐빈다.
    assert.ok(dayOfWeekMultiplier(city, 4) > dayOfWeekMultiplier(city, 0))
    assert.ok(dayOfWeekMultiplier(city, 5) > dayOfWeekMultiplier(city, 6))
  })
}

// 두 도시가 «같은 곡선을 복사한 게 아니라» 각자 데이터에서 나왔는지 확인한다.
// 아래 차이는 전부 2024년 실측에서 그대로 나온 것이다.

test('부산이 서울보다 낮 시간대에 붐빈다 — 통근 외 이용 비중이 높다', () => {
  const midday = (city: string) =>
    [11, 12, 13, 14].reduce((acc, h) => acc + demandMultiplier(city, h, MON), 0) / 4
  assert.ok(midday('BUSAN') > midday('SEOUL') * 1.2, `부산 ${midday('BUSAN')} vs 서울 ${midday('SEOUL')}`)
})

test('부산이 서울보다 출퇴근 피크가 완만하다', () => {
  const peak = (city: string, hours: number[]) =>
    Math.max(...hours.map(h => demandMultiplier(city, h, MON)))
  const midday = (city: string) => demandMultiplier(city, 13, MON)
  const sharpness = (city: string, hours: number[]) => peak(city, hours) / midday(city)

  assert.ok(sharpness('BUSAN', [7, 8]) < sharpness('SEOUL', [7, 8]), '아침 피크')
  assert.ok(sharpness('BUSAN', [17, 18]) < sharpness('SEOUL', [17, 18]), '저녁 피크')
})

test('부산은 저녁 8시 이후가 서울보다 빨리 식는다 — 야간 이용이 적다', () => {
  const night = (city: string) =>
    [20, 21, 22, 23].reduce((acc, h) => acc + demandMultiplier(city, h, MON), 0)
    / demandMultiplier(city, 13, MON)
  assert.ok(night('BUSAN') < night('SEOUL'), `부산 ${night('BUSAN')} < 서울 ${night('SEOUL')}`)
})

test('부산은 주말에 덜 빠진다 — 서울보다 통근 의존이 낮다', () => {
  const weekendRatio = (city: string) =>
    HOURS.reduce((acc, h) => acc + demandMultiplier(city, h, SAT), 0)
    / HOURS.reduce((acc, h) => acc + demandMultiplier(city, h, MON), 0)
  assert.ok(weekendRatio('BUSAN') > weekendRatio('SEOUL'),
    `부산 ${weekendRatio('BUSAN')} > 서울 ${weekendRatio('SEOUL')}`)
})

test('부산 관광역 분류에 실제 관광지가 잡힌다 — 분류가 데이터를 따라갔다는 증거', () => {
  const tourist = profile.cities.BUSAN.classification.TOURIST.examples.join(' ')
  for (const name of ['해운대', '광안', '남포']) {
    assert.ok(tourist.includes(name), `${name}이 관광역에 없다: ${tourist}`)
  }
})

// ─── 목적지 선택 (거리 감쇠 · 유형쌍 친화도) ─────────────────────────────

test('OD 모델이 실측 공공데이터에서 나왔다', () => {
  assert.equal(profile.od.source.datasets[0].id, '15113638')   // 서울특별시_지하철 역별 OD
  assert.equal(profile.od.deterrence.form, 'exp(-d/d0)')
  // 서울 지하철 실측: 감쇠 거리 7~8km, 평균 통행 7km 안팎
  assert.ok(OD_MODEL.deterrence.d0Km > 5 && OD_MODEL.deterrence.d0Km < 11, `d0=${OD_MODEL.deterrence.d0Km}`)
  assert.ok(OD_MODEL.deterrence.r2 > 0.9, `R²=${OD_MODEL.deterrence.r2}`)
  assert.ok(OD_MODEL.tripKm.mean > 4 && OD_MODEL.tripKm.mean < 10)
  assert.ok(OD_MODEL.passengers > 1_000_000)
})

test('맵 좌표가 실제 거리로 환산된다 — 서울역↔강남역 32칸 ≈ 9.6km', () => {
  assert.ok(Math.abs(mapDistanceToKm(32) - 9.6) < 0.1)
})

test('가까운 역이 먼 역보다 목적지로 잘 뽑힌다 — 예전엔 완전히 동등했다', () => {
  const near = destinationScore('SEOUL', 'RESIDENTIAL', 'COMMERCIAL', 8, MON, 7)   // 약 2km
  const far = destinationScore('SEOUL', 'RESIDENTIAL', 'COMMERCIAL', 8, MON, 70)   // 약 21km
  assert.ok(near > far * 2, `가까운 ${near} vs 먼 ${far}`)
  // 감쇠는 실측 d0를 따른다 — 같은 타입·시각이면 거리비만 남는다
  const ratio = near / far
  const expected = Math.exp((70 - 7) * TUNING.KM_PER_MAP_UNIT / OD_MODEL.deterrence.d0Km)
  assert.ok(Math.abs(ratio - expected) / expected < 1e-6)
})

test('거리 손잡이를 0으로 내리면 예전처럼 거리를 무시한다', () => {
  const original = TUNING.DISTANCE_STRENGTH
  try {
    // as never: 손잡이는 as const라 읽기 전용이지만, 테스트에서 효과만 확인한다
    ;(TUNING as { DISTANCE_STRENGTH: number }).DISTANCE_STRENGTH = 0
    const near = destinationScore('SEOUL', 'RESIDENTIAL', 'COMMERCIAL', 8, MON, 7)
    const far = destinationScore('SEOUL', 'RESIDENTIAL', 'COMMERCIAL', 8, MON, 70)
    assert.ok(Math.abs(near - far) < 1e-9, '거리 무시')
  } finally {
    ;(TUNING as { DISTANCE_STRENGTH: number }).DISTANCE_STRENGTH = original
  }
})

test('유형쌍 친화도는 대체로 1.0 근처고 거점↔거점만 뚜렷하다', () => {
  const aff = OD_MODEL.affinity as unknown as Record<string, Record<string, number>>
  assert.ok(aff.HUB.HUB > 1.3, `거점↔거점 ${aff.HUB.HUB}`)
  // 거리와 역 규모를 통제하고 나면 나머지는 대부분 설명된다 — 이 사실 자체가 결과다
  let offDiagonalMax = 0
  for (const a of STATION_TYPE_KEYS) {
    for (const b of STATION_TYPE_KEYS) {
      if (a === 'HUB' || b === 'HUB') continue
      offDiagonalMax = Math.max(offDiagonalMax, Math.abs(aff[a][b] - 1))
    }
  }
  assert.ok(offDiagonalMax < 0.35, `거점 외 최대 이탈 ${offDiagonalMax}`)
})
