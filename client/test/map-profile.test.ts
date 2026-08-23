import assert from 'node:assert/strict'
import test from 'node:test'

import profile from '../src/data/map-profile.json'
import { getCityMap, type DistrictKind } from '../src/maps'

const CITY_KEYS = ['SEOUL', 'BUSAN'] as const
const KINDS: DistrictKind[] = ['RESIDENTIAL', 'COMMERCIAL', 'TOURIST', 'INDUSTRIAL', 'HUB', 'GREEN']

// server/prisma/seed.ts의 시드 좌표. 서버 워크스페이스를 import하면 prisma가 딸려오므로
// 표를 복제한다 — seed.ts를 고칠 때 여기도 함께 고칠 것.
const SEED_POINTS: Record<string, Array<[string, number, number]>> = {
  SEOUL: [
    ['서울역', 44, 36], ['시청역', 43, 29], ['홍대입구역', 24, 38], ['영등포역', 22, 60],
    ['강남역', 60, 64], ['잠실역', 78, 58], ['청량리역', 66, 28], ['노원역', 70, 14],
    ['1호선 차고지', 71, 9], ['2호선 차고지', 82, 56],
    ['이태원정류장', 48, 44], ['버스 차고지', 63, 69],
  ],
  BUSAN: [
    ['중앙역', 48, 74], ['북항역', 46, 80], ['서면역', 52, 58], ['광안리역', 62, 62],
    ['사상역', 38, 52], ['해운대역', 74, 50], ['동래역', 54, 42], ['센텀역', 66, 52],
    ['1호선 차고지', 55, 37], ['2호선 차고지', 78, 45],
    ['광복정류장', 44, 76], ['버스 차고지', 48, 69],
  ],
}

// 'M x y L x y … Z' 계약에 기대 파싱한다. 진짜 SVG 파서가 필요해지는 순간
// 이 테스트는 없는 거나 마찬가지가 되므로, 빌드 쪽에서 형식을 좁게 유지한다.
function rings(d: string): Array<Array<[number, number]>> {
  return d.split('Z').filter(sub => /\d/.test(sub)).map(sub => {
    const nums = sub.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
    const ring: Array<[number, number]> = []
    for (let i = 0; i + 1 < nums.length; i += 2) ring.push([nums[i], nums[i + 1]])
    return ring
  })
}

function inRing(x: number, y: number, r: Array<[number, number]>) {
  let hit = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}
// evenodd — 안쪽 링이 저절로 구멍이 된다
const inPath = (x: number, y: number, rs: Array<Array<[number, number]>>) =>
  rs.reduce((acc, r) => acc !== inRing(x, y, r), false)

test('출처와 스키마가 붙어 있다', () => {
  assert.equal(profile.schema, 'no-last-train/map-profile@1')
  assert.match(profile.generatedAt, /^\d{4}-\d{2}-\d{2}$/)
  assert.deepEqual(Object.keys(profile.cities).sort(), [...CITY_KEYS].sort())

  const ids = profile.source.ridership.datasets.map(d => d.id)
  assert.ok(ids.includes('OA-12921'), '서울 승하차 데이터셋이 출처에 없다')
  assert.ok(ids.includes('3057229'), '부산 승하차 데이터셋이 출처에 없다')
  assert.equal(profile.source.elevation.basis, 'SRTM 1 Arc-Second + GMTED2010')
  assert.match(profile.source.landcover.license, /ODbL/)
})

test('맵 1칸이 실제 300m 안팎이고, 투영 잔차를 기록해 둔다', () => {
  for (const key of CITY_KEYS) {
    const p = profile.source.projection[key]
    // 서울역↔강남역 32칸 = 9.6km 기준의 KM_PER_MAP_UNIT=0.3과 같은 눈금인지
    for (const km of p.kmPerUnit) assert.ok(km > 0.25 && km < 0.6, `${key} km/칸 ${km}`)
    // 손으로 찍은 역 좌표에 맞춘 것이라 잔차가 0일 수 없다. 커지면 구역이 엉뚱한 곳에 간다.
    assert.ok(p.rmseUnits < 8, `${key} 투영 잔차 ${p.rmseUnits}칸`)
    assert.ok(p.stationsUsed > 60, `${key} 좌표 매칭 역 ${p.stationsUsed}개`)
  }
})

test('역 유형 분류가 실제로 아는 곳에 떨어진다', () => {
  const c = profile.source.classification
  const has = (city: 'SEOUL' | 'BUSAN', kind: string, name: string) =>
    (c[city] as Record<string, string[]>)[kind].some(s => s.includes(name))

  // PR #6 분류기(실측 승하차 곡선)의 출력이다. 사람이 눈으로 검증할 수 있어야 한다.
  for (const name of ['강남', '잠실', '홍대입구']) assert.ok(has('SEOUL', 'HUB', name), `${name}이 거점에 없다`)
  for (const name of ['사당', '수유', '노원']) assert.ok(has('SEOUL', 'RESIDENTIAL', name), `${name}이 주거에 없다`)
  // 산업형은 공단이 아니라 «평일 전용 업무지구»로 나온다 — README가 설명하는 그대로다.
  assert.ok(has('SEOUL', 'INDUSTRIAL', '여의도'), '여의도가 평일 업무지구로 안 잡혔다')
  for (const name of ['해운대', '광안', '남포']) assert.ok(has('BUSAN', 'TOURIST', name), `${name}이 관광에 없다`)
  assert.ok(has('BUSAN', 'HUB', '서면'), '서면이 거점에 없다')
})

test('구역 이름이 그 안에서 제일 붐비는 역에서 나온다', () => {
  const nameOf = (key: 'SEOUL' | 'BUSAN') => new Map(getCityMap(key).districts.map(d => [d.name, d.kind]))
  const seoul = nameOf('SEOUL'), busan = nameOf('BUSAN')
  assert.equal(seoul.get('강남 거점'), 'HUB')
  assert.equal(seoul.get('잠실 거점'), 'HUB')
  assert.equal(busan.get('서면 거점'), 'HUB')
  assert.equal(busan.get('해운대 관광'), 'TOURIST')
})

for (const key of CITY_KEYS) {
  const map = getCityMap(key)

  test(`${key} · 구역이 겹치지 않고 땅을 덮는다`, () => {
    // 요구사항의 핵심: 경계는 닿아도 겹치면 안 된다.
    // 256² 격자에 «몇 개 구역이 이 칸을 주장하는가»를 세면 겹침·빈틈·바다 침범이 한 번에 나온다.
    // 표본점을 칸 «중앙»에 두면 정점 격자(0.02)와 절대 같아질 수 없어 경계 위 동점이 없다.
    const parsed = map.districts.map(d => {
      const rs = rings(d.d)
      let bb = [Infinity, Infinity, -Infinity, -Infinity]
      for (const r of rs) for (const [x, y] of r) {
        bb = [Math.min(bb[0], x), Math.min(bb[1], y), Math.max(bb[2], x), Math.max(bb[3], y)]
      }
      return { name: d.name, rs, bb, hits: 0 }
    })

    const S = 256
    let overlap = 0, land = 0, landUncovered = 0, covered = 0, coveredWater = 0
    const witness: string[] = []
    for (let jy = 0; jy < S; jy++) for (let ix = 0; ix < S; ix++) {
      const x = (ix + 0.5) * 100 / S, y = (jy + 0.5) * 100 / S
      const isLand = map.isLand(x, y)
      let hits = 0
      const who: string[] = []
      for (const p of parsed) {
        if (x < p.bb[0] || x > p.bb[2] || y < p.bb[1] || y > p.bb[3]) continue
        if (inPath(x, y, p.rs)) { hits++; p.hits++; who.push(p.name) }
      }
      if (isLand) land++
      if (hits > 0) covered++
      if (hits > 1) { overlap++; if (witness.length < 3) witness.push(`(${x.toFixed(1)},${y.toFixed(1)}) ${who.join(' × ')}`) }
      if (isLand && hits === 0) landUncovered++
      if (!isLand && hits > 0) coveredWater++
    }

    assert.equal(overlap, 0, `구역이 겹친다: ${witness.join(' / ')}`)
    assert.ok(landUncovered / land < 0.03, `땅인데 어느 구역에도 안 덮인 비율 ${(landUncovered / land * 100).toFixed(1)}%`)
    assert.ok(coveredWater / covered < 0.03, `구역이 물을 덮은 비율 ${(coveredWater / covered * 100).toFixed(1)}%`)
    for (const p of parsed) assert.ok(p.hits > 0, `${p.name}이 한 칸도 차지하지 않는다`)
  })

  test(`${key} · 구역 구성이 지도로 읽힌다`, () => {
    // 손으로 그리던 시절 서울 12개·부산 7개였다. 너무 적으면 뭉개지고 너무 많으면 라벨이 겹친다.
    assert.ok(map.districts.length >= 15 && map.districts.length <= 60, `구역 ${map.districts.length}개`)
    const used = new Set(map.districts.map(d => d.kind))
    for (const kind of KINDS) assert.ok(used.has(kind), `${kind} 구역이 하나도 없다 — 팔레트 한 줄이 죽은 코드다`)
    assert.equal(new Set(map.districts.map(d => d.name)).size, map.districts.length, '구역 이름이 겹친다')

    for (const d of map.districts) {
      assert.ok(KINDS.includes(d.kind), `${d.name}: 모르는 유형 ${d.kind}`)
      assert.match(d.d, /^M[-\d. LZM]+Z$/, `${d.name}: 경로에 곡선·상대명령이 섞였다`)
      const [lx, ly] = d.label
      assert.ok(inPath(lx, ly, rings(d.d)), `${d.name}: 라벨이 구역 밖에 있다`)
    }
    assert.ok(map.guLabels.length >= 10, `자치구 라벨 ${map.guLabels.length}개`)
  })

  test(`${key} · 랜드마스크가 계약대로다`, () => {
    assert.equal(atob(profile.cities[key].landMask).length, 8192, '256×256 1비트 = 8192바이트여야 한다')

    // 맵 밖과 NaN은 반드시 물이다. 실수 좌표에서 걸러야 -0.5가 0칸으로 둔갑하지 않는다.
    for (const [x, y] of [[-1, 50], [100, 50], [50, -1], [50, 100], [NaN, 50], [50, NaN]]) {
      assert.equal(map.isLand(x, y), false, `isLand(${x}, ${y})`)
    }

    let land = 0
    for (let y = 0.2; y < 100; y += 0.4) for (let x = 0.2; x < 100; x += 0.4) if (map.isLand(x, y)) land++
    const frac = land / (250 * 250)
    assert.ok(frac > 0.15 && frac < 0.85, `땅 비율 ${(frac * 100).toFixed(0)}%`)
  })

  test(`${key} · 시드가 심는 좌표가 전부 땅이다`, () => {
    // 여기가 빨개지면 server/prisma/seed.ts의 좌표를 옮겨야 한다.
    // 물 위에 심으면 역 아이콘이 강에 뜨고 이동이 막힌다.
    for (const [name, x, y] of SEED_POINTS[key]) {
      assert.ok(map.isLand(x, y), `${key} ${name} (${x}, ${y})가 물이다`)
    }
  })

  test(`${key} · 해안선이 랜드마스크와 같은 땅을 그린다`, () => {
    // 둘이 어긋나면 화면에는 땅인데 역을 못 짓거나, 물인데 시민이 걸어 다닌다.
    // 실제로 어긋난 적이 있다 — traceMask의 술어가 격자 밖에서 undefined !== WATER → true라
    // 맵 전체를 땅으로 보고 서울 해안선이 통째로 사라졌다. 렌더링에서만 티가 났다.
    const rs = rings(map.coastline)
    let n = 0, agree = 0
    for (let y = 0.2; y < 100; y += 0.4) for (let x = 0.2; x < 100; x += 0.4) {
      n++
      if (map.isLand(x, y) === inPath(x, y, rs)) agree++
    }
    assert.ok(agree / n > 0.97, `해안선과 랜드마스크가 ${((1 - agree / n) * 100).toFixed(1)}% 어긋난다`)
  })

  test(`${key} · 지형이 실제 기복을 담고 있다`, () => {
    assert.ok(map.coastline.startsWith('M'), '해안선이 비었다')
    assert.ok(map.reliefBands.length >= 2, '고도대가 없다')
    assert.ok(map.contours.length >= 2, '등고선이 없다')
    // 높은 밴드가 낮은 밴드보다 작아야 «산»이다
    const [low, high] = map.reliefBands
    assert.ok(high.minM > low.minM && high.d.length < low.d.length, '고도대가 높을수록 좁아지지 않는다')
    for (const c of map.contours) assert.match(c.d, /^M[-\d. LM]+$/, `${c.elevM}m 등고선에 Z가 섞였다`)
  })
}

test('용량이 첫 페인트를 해치지 않는다', () => {
  // 이 JSON은 번들에 그대로 실린다(클라이언트 JS 672KB 중 절반쯤). 지금 326KB.
  // 격자·등고선 해상도나 SNAP을 건드리면 조용히 두 배가 되므로 울타리를 둔다.
  const bytes = JSON.stringify(profile).length
  assert.ok(bytes < 450_000, `${(bytes / 1024).toFixed(0)}KB — SNAP·SHAPE_EPS·CONTOUR_M을 확인할 것`)
})
