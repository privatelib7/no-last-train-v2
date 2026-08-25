#!/usr/bin/env node
// 공공데이터 → 지도 구역·지형 프로필(../client/src/data/map-profile.json)
//
//   node scripts/build-map-profile.mjs [--city SEOUL,BUSAN] [--days 364] [--refresh]
//
// 손으로 그리던 구역·산·강·해안선을 실측에서 굽는다. 핵심은 «격자에 한 칸 한 유형»이다.
// 폴리곤을 겹치지 않게 잘라 붙이는 대신 256×256 격자의 각 칸에 유형을 정확히 하나만
// 배정한 뒤 윤곽을 뽑으므로, 구역이 겹치는 일이 «검사해서 없는» 게 아니라 불가능하다.
//
// 칸의 유형을 정하는 신호 (우선순위 순):
//   1. WATER   OSM 수역 폴리곤 + SRTM 고도
//   2. GREEN   OSM 공원·산림·묘지·농지 폴리곤 «면적» + SRTM 고도 ≥ ELEV_CUT
//   3. 나머지  실측 승하차로 분류된 «역»을 거리감쇠 영향장으로 퍼뜨려 유형별 정규화 후 argmax
//
// 3번은 새 분류기를 만들지 않는다. build-demand-profile.mjs의 classifyStations()를
// 그대로 태운다 — 강남·잠실이 거점, 사당·수유가 주거, 여의도·공덕이 평일 업무지구로
// 나오는 그 분류다. 개찰구 통과량만이 주거와 상업을 가른다(POI 밀도로는 안 갈린다.
// 한국은 주거지 1층이 전부 상가라 노원역 500m 안에 상업 POI가 427개 있다).
//
// 원본 (전부 인증키 없음):
//   승하차   서울 OA-12921 / 부산 3057229          (build-demand-profile.mjs 경유)
//   역 좌표  OSM Overpass railway=station
//   토지피복 OSM Overpass landuse/leisure/natural   (ODbL — 출처 표기 필요)
//   고도     AWS Open Data terrain-tiles (terrarium, SRTM+GMTED) z=12
//   구 이름  통계청 센서스 시군구 경계 (southkorea-maps kostat/2018, free to share)
//
// ── 산출물이 클라이언트에 지는 계약 (client/src/maps.ts가 이대로 기댄다) ──
//   landMask   base64 디코드 시 정확히 8192바이트. 256×256, 1비트/칸, 행 우선,
//              바이트 안에서 MSB 먼저, 비트 인덱스 y*256+x, 1이면 걸을 수 있는 땅.
//              경로 문자열과 «같은» 투영 0~100 공간에서 래스터화한다. 어긋나면
//              해안선과 isLand가 다른 말을 해서 역이 물 위에 뜬다.
//   d          절대 'M x y L x y … Z'. 곡선·상대명령 없음, 소수 2자리.
//              런타임은 파싱하지 않지만 map-profile.test.ts가 파싱한다.
//   kind       RESIDENTIAL | COMMERCIAL | TOURIST | INDUSTRIAL | HUB | GREEN
//   감김 방향  무관. 클라이언트가 fill-rule="evenodd"로 그려 안쪽 링이 구멍이 된다.
//
// 만들어진 JSON은 커밋한다. 게임 실행 중에는 네트워크를 타지 않는다.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { loadSeoulRides, loadBusanRides, classifyStations } from './build-demand-profile.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_DIR = path.join(ROOT, '.cache')
// 서버는 맵 지오메트리를 가진 적이 없다(구역은 장식이다). 클라이언트에만 쓴다.
const OUT_FILE = path.join(ROOT, '../client/src/data/map-profile.json')

const SCHEMA = 'no-last-train/map-profile@1'
const KINDS = ['RESIDENTIAL', 'COMMERCIAL', 'TOURIST', 'INDUSTRIAL', 'HUB', 'GREEN']
const KIND_LABEL = {
  RESIDENTIAL: '주거', COMMERCIAL: '상업', TOURIST: '관광',
  INDUSTRIAL: '산업', HUB: '거점', GREEN: '녹지',
}
const WATER = -1

const MAP_TUNING = {
  // 역 중심 기준 등방 축소. 1이면 실측 그대로라 도시가 맵 밖으로 더 나가고,
  // 낮추면 덜 잘리는 대신 역이 자기 동네에서 멀어진다.
  // 측정: 서울 0.95 → 시드 역 7/8 적중·면적 6.9% 잘림 / 부산 0.85 → 7/8·8.5%
  FIT_SCALE: { SEOUL: 0.95, BUSAN: 0.85 },
  // 역 영향 반경(km). 크면 구역이 뭉개지고 작으면 역마다 조각난다.
  LAMBDA_KM: 1.1,
  // 역이 아주 먼 곳(부산 강서구처럼 지하철이 없는 외곽)은 모든 유형의 장이 0에 가까워
  // 유형별 정규화만 남으면 잡음이 이긴다 — 실제로 논밭에 «거점»이 세 개 생겼다.
  // 도시 평균 대비 이만큼도 안 되면 근거가 없다고 보고 주거로 떨어뜨린다.
  FIELD_FLOOR: 0.05,
  // 이 위는 녹지·산지. «몇 m»로 고정하면 안 된다 — 서울에 맞춘 110m를 부산에 그대로 쓰니
  // 부산 땅의 17%가 녹지가 되고 주거는 4%로 쪼그라들었다. 부산은 비탈에 동네가 앉아 있어서
  // 100~200m가 시가지다. 그래서 «그 도시 땅의 상위 몇 %»로 잡는다(서울 ≈ 120m, 부산 ≈ 230m).
  ELEV_CUT_Q: 0.82,
  // 분위수가 이상하게 나올 때를 위한 울타리.
  ELEV_CUT_MIN_M: 80,
  ELEV_CUT_MAX_M: 400,
  // 이보다 작은 덩어리는 가장 많이 맞닿은 이웃에 흡수된다 → 구역 «개수»를 정하는 손잡이.
  // 격자 대비 비율. 너무 키우면 여의도·홍대·성수처럼 «작지만 성격이 뚜렷한» 중심이
  // 옆의 큰 덩어리에 먹힌다(0.004로 뒀다가 실제로 셋 다 먹혔다).
  MIN_BLOB: 0.0015,
  // 분류 격자이자 랜드마스크 해상도. 마스크 계약이 256×256이라 둘을 하나로 묶어 두었다
  // — 따로 두면 좌표계가 둘이 되고, 어긋나는 순간 역이 물 위에 뜬다. 1칸 ≈ 117m.
  GRID: 256,
  // 정점 격자. 공유 경계 정합의 근거이므로 도시별로 다르게 두지 않는다.
  // 0.1칸 = 30m로, 분류 격자 한 칸(117m)보다 훨씬 잘아 눈에 띄는 손실이 없다.
  // 좌표를 소수 한 자리로 줄여 번들이 가벼워진다.
  SNAP: 0.1,
  // 윤곽 단순화 허용 오차(칸). 공유 경계는 호 단위로 «양쪽이 같은 값»을 써야 한다.
  SHAPE_EPS: 0.4,
  // 서울 중앙값 고도가 40m라 50m선을 그리면 시가지 전체가 실뱀처럼 뒤덮인다(그것만 102KB).
  // 첫 고도대와 같은 100m부터 그려야 «산이 여기 있다»는 그림이 된다.
  CONTOUR_M: [100, 200, 400, 800],
  // 등고선 단순화 허용 오차와 최소 길이(칸). 짧은 토막은 지형이 아니라 잡음이다.
  CONTOUR_EPS: 0.12,
  CONTOUR_MIN_LEN: 1.5,
  RELIEF_M: [100, 300],
}

// 투영의 기준점. server/prisma/seed.ts의 시드 좌표와 «함께» 고쳐야 한다.
// 부산 시드에는 실존하지 않는 역 이름이 있어 대응하는 실제 역을 적어 둔다.
const SEED_ANCHORS = {
  SEOUL: [
    ['서울역', 126.9707, 37.5546, 44, 36],
    ['시청역', 126.9770, 37.5657, 43, 29],
    ['홍대입구역', 126.9245, 37.5571, 24, 38],
    ['영등포역', 126.9074, 37.5155, 22, 60],
    ['강남역', 127.0276, 37.4979, 60, 64],
    ['잠실역', 127.1000, 37.5133, 78, 58],
    ['청량리역', 127.0469, 37.5800, 66, 28],
    ['노원역', 127.0614, 37.6554, 70, 14],
  ],
  BUSAN: [
    ['중앙역', 129.0345, 35.1041, 48, 74],
    ['북항역', 129.0413, 35.1151, 46, 80],   // 실제 부산역(북항 일대)
    ['서면역', 129.0594, 35.1578, 52, 58],
    ['광안리역', 129.1128, 35.1553, 62, 62], // 실제 광안역
    ['사상역', 128.9855, 35.1626, 38, 52],
    ['해운대역', 129.1590, 35.1631, 74, 50],
    ['동래역', 129.0787, 35.2049, 54, 42],
    ['센텀역', 129.1310, 35.1693, 66, 52],   // 실제 센텀시티역
  ],
}

const CITIES = {
  SEOUL: { name: '서울', bbox: [126.76, 37.42, 127.19, 37.70], guPrefix: /^11/ },
  BUSAN: { name: '부산', bbox: [128.90, 35.05, 129.30, 35.40], guPrefix: /^21/ },
}

const OVERPASS = 'https://overpass-api.de/api/interpreter'
const TERRAIN = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'
const TERRAIN_Z = 12
const GU_GEOJSON = 'https://raw.githubusercontent.com/southkorea/southkorea-maps/master/kostat/2018/json/skorea-municipalities-2018-geo.json'

// ─── 유틸 ────────────────────────────────────────────────────────────────

async function cached(file, refresh, produce) {
  const full = path.join(CACHE_DIR, file)
  if (!refresh && existsSync(full)) return readFile(full)
  const body = await produce()
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, body)
  return body
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Overpass는 node의 기본 User-Agent를 406으로 걷어찬다. 그리고 동시 슬롯이 2개뿐이라
// 몰아치면 JSON 대신 XML 오류 보고서를 뱉는다 — 둘 다 여기서 처리한다.
const UA = 'no-last-train/1.0 (build-map-profile.mjs)'

async function overpass(query, cacheName, refresh, onProgress) {
  const buf = await cached(`osm/${cacheName}.json`, refresh, async () => {
    for (let attempt = 1; ; attempt++) {
      onProgress?.(`Overpass ${cacheName}${attempt > 1 ? ` (재시도 ${attempt})` : ''}`)
      const res = await fetch(OVERPASS, {
        method: 'POST',
        headers: { 'User-Agent': UA },
        body: new URLSearchParams({ data: query }),
      })
      const text = await res.text()
      if (res.ok && text.startsWith('{')) return Buffer.from(text)
      if (attempt >= 4) throw new Error(`Overpass 실패 (${cacheName}): ${text.slice(0, 200)}`)
      await sleep(attempt * 10_000)
    }
  })
  return JSON.parse(buf.toString('utf8'))
}

// 정규방정식 최소제곱. 좌표를 중심화해 넘겨야 조건수가 산다.
function lstsq(A, b) {
  const n = A[0].length
  const M = []
  for (let i = 0; i < n; i++) {
    const row = new Array(n + 1).fill(0)
    for (let j = 0; j < n; j++) { let s = 0; for (let r = 0; r < A.length; r++) s += A[r][i] * A[r][j]; row[j] = s }
    let s = 0; for (let r = 0; r < A.length; r++) s += A[r][i] * b[r]
    row[n] = s
    M.push(row)
  }
  for (let i = 0; i < n; i++) {
    let p = i
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r
    const t = M[i]; M[i] = M[p]; M[p] = t
    for (let r = 0; r < n; r++) {
      if (r === i) continue
      const f = M[r][i] / M[i][i]
      for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c]
    }
  }
  return M.map((row, i) => row[n] / row[i])
}

// 위경도 → 맵 0~100. 시드 역 8개에 아핀을 맞춘 뒤 역 중심 기준으로 FIT_SCALE만큼 줄인다.
// 손으로 찍은 역 좌표가 사실상 지리 투영이라(회전 ≈ 0, 서울 0.29km/칸) 이게 성립한다.
function fitProjection(cityKey) {
  const anchors = SEED_ANCHORS[cityKey]
  const scale = MAP_TUNING.FIT_SCALE[cityKey]
  const lon0 = anchors.reduce((a, r) => a + r[1], 0) / anchors.length
  const lat0 = anchors.reduce((a, r) => a + r[2], 0) / anchors.length
  const kLat = 111.0
  const kLon = 111.32 * Math.cos(lat0 * Math.PI / 180)
  const A = anchors.map(([, lon, lat]) => [(lon - lon0) * kLon, (lat - lat0) * kLat, 1])
  const cx = lstsq(A, anchors.map(r => r[3]))
  const cy = lstsq(A, anchors.map(r => r[4]))
  const [ax, bx, ox] = [cx[0] * scale, cx[1] * scale, cx[2]]
  const [ay, by, oy] = [cy[0] * scale, cy[1] * scale, cy[2]]
  const det = ax * by - bx * ay
  const project = (lon, lat) => {
    const e = (lon - lon0) * kLon, n = (lat - lat0) * kLat
    return [ox + ax * e + bx * n, oy + ay * e + by * n]
  }
  const unproject = (x, y) => {
    const u = x - ox, v = y - oy
    return [lon0 + ((by * u - bx * v) / det) / kLon, lat0 + ((-ay * u + ax * v) / det) / kLat]
  }
  let ss = 0
  for (const [, lon, lat, mx, my] of anchors) {
    const [px, py] = project(lon, lat)
    ss += (px - mx) ** 2 + (py - my) ** 2
  }
  return {
    project, unproject,
    stats: {
      fitScale: scale,
      rmseUnits: Math.round(Math.sqrt(ss / anchors.length) * 100) / 100,
      kmPerUnit: [Math.hypot(ax, bx), Math.hypot(ay, by)].map(v => Math.round(1000 / v) / 1000),
    },
  }
}

// ─── 원본 취득 ───────────────────────────────────────────────────────────

// next가 이미 끌고 와 루트 node_modules에 있다. 새 의존성을 만들지 않으려고 빌린다.
function loadSharp() {
  try {
    return createRequire(import.meta.url)('sharp')
  } catch {
    throw new Error('build-map-profile은 고도 타일(PNG) 디코딩에 sharp가 필요하다. `npm install` 후 다시 실행할 것.')
  }
}

const normName = name => name.replace(/\(.*?\)/g, '').replace(/역$/, '').trim()

async function fetchStationCoords(cityKey, refresh, onProgress) {
  const [w, s, e, n] = CITIES[cityKey].bbox
  const bb = `${s},${w},${n},${e}`
  const query = `[out:json][timeout:280];(
    node["railway"="station"]["station"="subway"](${bb});
    node["railway"="station"]["subway"="yes"](${bb});
  );out tags center;`
  const data = await overpass(query, `${cityKey}-stations`, refresh, onProgress)
  const coords = new Map()
  for (const el of data.elements) {
    const raw = el.tags?.['name:ko'] ?? el.tags?.name
    if (!raw) continue
    const key = normName(raw)
    if (!coords.has(key)) coords.set(key, [el.lon, el.lat])
  }
  return coords
}

// 녹지·수역은 «면적»으로 쓴다. 중심점으로 세면 북한산이 점 하나가 된다.
// 산림·공원은 OSM에서 relation(다중폴리곤)인 경우가 많아 nwr + out geom으로 받는다.
const GREEN_TAGS = new Set([
  'leisure=park', 'leisure=nature_reserve', 'leisure=garden',
  'landuse=forest', 'landuse=cemetery', 'landuse=grass', 'landuse=meadow',
  'landuse=farmland', 'landuse=allotments', 'landuse=orchard', 'landuse=village_green',
  'natural=wood', 'natural=scrub', 'natural=heath', 'natural=grassland',
])
const WATER_TAGS = new Set(['natural=water', 'waterway=riverbank', 'landuse=reservoir', 'natural=wetland'])

const tagKey = t => t.landuse ? `landuse=${t.landuse}`
  : t.leisure ? `leisure=${t.leisure}`
  : t.waterway ? `waterway=${t.waterway}`
  : t.natural ? `natural=${t.natural}` : ''

async function fetchLandCover(cityKey, refresh, onProgress) {
  const [w, s, e, n] = CITIES[cityKey].bbox
  const bb = `${s},${w},${n},${e}`
  const query = `[out:json][timeout:280];(
    nwr["landuse"~"^(forest|cemetery|grass|meadow|farmland|allotments|orchard|village_green|reservoir)$"](${bb});
    nwr["leisure"~"^(park|nature_reserve|garden)$"](${bb});
    nwr["natural"~"^(wood|scrub|heath|grassland|water|wetland)$"](${bb});
    nwr["waterway"="riverbank"](${bb});
  );out geom;`
  const data = await overpass(query, `${cityKey}-landcover`, refresh, onProgress)
  return data.elements
}

async function fetchGuBoundaries(refresh, onProgress) {
  const buf = await cached('kostat/skorea-municipalities-2018.json', refresh, async () => {
    onProgress?.('통계청 시군구 경계 내려받는 중')
    const res = await fetch(GU_GEOJSON)
    if (!res.ok) throw new Error(`시군구 경계 내려받기 실패: ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  })
  return JSON.parse(buf.toString('utf8'))
}

// terrarium: elev = R*256 + G + B/256 - 32768
async function elevationSampler(refresh, onProgress) {
  const sharp = loadSharp()
  const tiles = new Map()
  const lon2t = l => (l + 180) / 360 * 2 ** TERRAIN_Z
  const lat2t = l => {
    const r = l * Math.PI / 180
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** TERRAIN_Z
  }
  async function tile(tx, ty) {
    const key = `${tx}/${ty}`
    if (tiles.has(key)) return tiles.get(key)
    const buf = await cached(`terrain/${TERRAIN_Z}-${tx}-${ty}.png`, refresh, async () => {
      onProgress?.(`고도 타일 ${TERRAIN_Z}/${tx}/${ty}`)
      const res = await fetch(`${TERRAIN}/${TERRAIN_Z}/${tx}/${ty}.png`)
      if (!res.ok) throw new Error(`고도 타일 실패 ${TERRAIN_Z}/${tx}/${ty}: ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    })
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true })
    const t = { data, ch: info.channels, w: info.width }
    tiles.set(key, t)
    return t
  }
  return {
    async at(lon, lat) {
      const fx = lon2t(lon), fy = lat2t(lat)
      const tx = Math.floor(fx), ty = Math.floor(fy)
      const t = await tile(tx, ty)
      const px = Math.min(t.w - 1, Math.floor((fx - tx) * t.w))
      const py = Math.min(t.w - 1, Math.floor((fy - ty) * t.w))
      const i = (py * t.w + px) * t.ch
      return t.data[i] * 256 + t.data[i + 1] + t.data[i + 2] / 256 - 32768
    },
    get count() { return tiles.size },
  }
}

// ─── 래스터 ──────────────────────────────────────────────────────────────

// 스캔라인 채우기. 폴리곤이 덮는 «면적»을 격자에 찍는다.
function fillPolygon(mask, N, pts, value = 1) {
  if (pts.length < 3) return
  const cell = 100 / N
  let lo = Infinity, hi = -Infinity
  for (const [, y] of pts) { if (y < lo) lo = y; if (y > hi) hi = y }
  const j0 = Math.max(0, Math.ceil(lo / cell - 0.5))
  const j1 = Math.min(N - 1, Math.floor(hi / cell - 0.5))
  const xs = []
  for (let jy = j0; jy <= j1; jy++) {
    const y = (jy + 0.5) * cell
    xs.length = 0
    for (let i = 0, k = pts.length - 1; i < pts.length; k = i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[k]
      if ((ay > y) !== (by > y)) xs.push(ax + (bx - ax) * (y - ay) / (by - ay))
    }
    xs.sort((a, b) => a - b)
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const i0 = Math.max(0, Math.ceil(xs[s] / cell - 0.5))
      const i1 = Math.min(N - 1, Math.floor(xs[s + 1] / cell - 0.5))
      for (let ix = i0; ix <= i1; ix++) mask[jy * N + ix] = value
    }
  }
}

// 다중폴리곤(relation)의 겉면은 «조각난 way 여러 개»로 온다. 조각 하나하나를 닫힌
// 폴리곤으로 칠하면 한강이 군데군데 끊긴 얼룩이 된다 — 실제로 강 서쪽 절반이 땅으로 남았다.
// 끝점을 이어 링을 완성한 다음에 칠해야 한다.
function assembleRings(members) {
  const k = pt => `${pt.lon.toFixed(7)},${pt.lat.toFixed(7)}`
  const open = members.map(m => m.geometry.filter(Boolean)).filter(g => g.length > 1)
  const rings = []
  const used = new Array(open.length).fill(false)
  for (let seed = 0; seed < open.length; seed++) {
    if (used[seed]) continue
    used[seed] = true
    const ring = open[seed].slice()
    for (let guard = 0; guard < open.length; guard++) {
      const tail = k(ring[ring.length - 1])
      if (tail === k(ring[0])) break
      let joined = false
      for (let i = 0; i < open.length; i++) {
        if (used[i]) continue
        const w = open[i]
        if (k(w[0]) === tail) { ring.push(...w.slice(1)); used[i] = true; joined = true; break }
        if (k(w[w.length - 1]) === tail) { ring.push(...w.slice(0, -1).reverse()); used[i] = true; joined = true; break }
      }
      if (!joined) break
    }
    if (ring.length >= 4) rings.push(ring)
  }
  return rings
}

// 안쪽 링은 «구멍»이다. outer만 칠하고 말면 한강 관계의 안쪽 링인 여의도가 강물로 덮인다.
function rasterizeLandCover(elements, project, N, tagSet) {
  const mask = new Uint8Array(N * N)
  const toPts = ring => ring.map(g => project(g.lon, g.lat))
  for (const el of elements) {
    if (!tagSet.has(tagKey(el.tags ?? {}))) continue
    if (el.geometry) { fillPolygon(mask, N, toPts(el.geometry.filter(Boolean)), 1); continue }
    const members = (el.members ?? []).filter(m => m.geometry?.length)
    for (const role of ['outer', 'inner']) {
      const part = members.filter(m => (m.role === 'inner') === (role === 'inner'))
      for (const ring of assembleRings(part)) fillPolygon(mask, N, toPts(ring), role === 'inner' ? 0 : 1)
    }
  }
  return mask
}

// ─── 격자 정리 ───────────────────────────────────────────────────────────

// 3×3 다수결. 자기 칸에 가중치를 줘서 과하게 뭉개지지 않게 한다.
function majorityFilter(cls, N) {
  const out = new Int8Array(cls)
  const tally = new Map()
  for (let jy = 0; jy < N; jy++) for (let ix = 0; ix < N; ix++) {
    const self = cls[jy * N + ix]
    if (self === WATER) continue
    tally.clear()
    tally.set(self, 2)
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const u = ix + dx, v = jy + dy
      if (u < 0 || u >= N || v < 0 || v >= N || (!dx && !dy)) continue
      const k = cls[v * N + u]
      if (k === WATER) continue
      tally.set(k, (tally.get(k) ?? 0) + 1)
    }
    let best = self, bv = -1
    for (const [k, v] of tally) if (v > bv || (v === bv && k < best)) { best = k; bv = v }
    out[jy * N + ix] = best
  }
  return out
}

// 4-연결 연결요소. 같은 유형이라도 떨어져 있으면 다른 구역이다.
function components(cls, N) {
  const comp = new Int32Array(N * N).fill(-1)
  const list = []
  const stack = []
  for (let start = 0; start < N * N; start++) {
    if (cls[start] === WATER || comp[start] !== -1) continue
    const id = list.length
    const kind = cls[start]
    const cells = []
    comp[start] = id
    stack.push(start)
    while (stack.length) {
      const p = stack.pop()
      cells.push(p)
      const ix = p % N, jy = (p / N) | 0
      if (ix > 0 && cls[p - 1] === kind && comp[p - 1] === -1) { comp[p - 1] = id; stack.push(p - 1) }
      if (ix < N - 1 && cls[p + 1] === kind && comp[p + 1] === -1) { comp[p + 1] = id; stack.push(p + 1) }
      if (jy > 0 && cls[p - N] === kind && comp[p - N] === -1) { comp[p - N] = id; stack.push(p - N) }
      if (jy < N - 1 && cls[p + N] === kind && comp[p + N] === -1) { comp[p + N] = id; stack.push(p + N) }
    }
    list.push({ id, kind, cells })
  }
  return { comp, list }
}

// 작은 덩어리를 가장 길게 맞닿은 이웃에 흡수한다. 구역 개수를 정하는 곳.
function absorbSmall(cls, N, minCells) {
  for (let guard = 0; guard < 12; guard++) {
    const { comp, list } = components(cls, N)
    const small = list.filter(c => c.cells.length < minCells).sort((a, b) => a.cells.length - b.cells.length)
    if (!small.length) return cls
    let changed = false
    for (const blob of small) {
      const touch = new Map()
      for (const p of blob.cells) {
        const ix = p % N, jy = (p / N) | 0
        for (const q of [ix > 0 ? p - 1 : -1, ix < N - 1 ? p + 1 : -1, jy > 0 ? p - N : -1, jy < N - 1 ? p + N : -1]) {
          if (q < 0 || cls[q] === WATER || comp[q] === blob.id) continue
          touch.set(cls[q], (touch.get(cls[q]) ?? 0) + 1)
        }
      }
      // 붙일 이웃이 없는 작은 덩어리 = 물 위에 뜬 몇 칸짜리 섬. 1칸이 117m라 잡음이다.
      // 남겨 두면 면적이 0에 수렴하는 «구역»이 되므로 물로 되돌린다.
      let best = WATER, bv = -1
      for (const [k, v] of touch) if (v > bv) { bv = v; best = k }
      for (const p of blob.cells) cls[p] = best
      changed = true
    }
    if (!changed) return cls
  }
  return cls
}

// 챔퍼 거리변환 후 최대점 — 오목한 구역에서도 라벨이 안쪽에 앉는다.
function poleOfInaccessibility(cells, N) {
  const inside = new Set(cells)
  const dist = new Map()
  for (const p of cells) dist.set(p, Infinity)
  const at = p => (p < 0 || !inside.has(p)) ? 0 : (dist.get(p) ?? 0)
  const sorted = [...cells].sort((a, b) => a - b)
  for (const p of sorted) {
    const ix = p % N, jy = (p / N) | 0
    let d = Math.min(
      ix > 0 ? at(p - 1) + 1 : 0,
      jy > 0 ? at(p - N) + 1 : 0,
      ix > 0 && jy > 0 ? at(p - N - 1) + 1.414 : 0,
      ix < N - 1 && jy > 0 ? at(p - N + 1) + 1.414 : 0,
    )
    dist.set(p, d)
  }
  let best = sorted[0], bv = -1
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]
    const ix = p % N, jy = (p / N) | 0
    const d = Math.min(dist.get(p),
      ix < N - 1 ? at(p + 1) + 1 : 0,
      jy < N - 1 ? at(p + N) + 1 : 0,
      ix < N - 1 && jy < N - 1 ? at(p + N + 1) + 1.414 : 0,
      ix > 0 && jy < N - 1 ? at(p + N - 1) + 1.414 : 0)
    dist.set(p, d)
    if (d > bv) { bv = d; best = p }
  }
  const cell = 100 / N
  return [((best % N) + 0.5) * cell, (((best / N) | 0) + 0.5) * cell]
}

// ─── 벡터화 ──────────────────────────────────────────────────────────────

// 격자 모서리에서 «세 종류 이상이 만나는» 자리. 여기를 고정점으로 잡는 것이 이 파일의 핵심이다.
// 구역 A와 B가 공유하는 경계는 두 고정점 사이의 «똑같은» 정점열이고, 단순화도 스무딩도
// 순서 뒤집기에 대칭이라 양쪽이 글자 그대로 같은 곡선을 얻는다 → 겹침이 생길 수 없다.
function junctionCorners(cls, N) {
  const pinned = new Set()
  const lab = (ix, jy) => (ix < 0 || ix >= N || jy < 0 || jy >= N) ? -9 : cls[jy * N + ix]
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const a = lab(i - 1, j - 1), b = lab(i, j - 1), c = lab(i - 1, j), d = lab(i, j)
    const distinct = new Set([a, b, c, d]).size
    // 대각선으로만 맞닿아 이어붙일 방향이 애매한 자리도 고정한다.
    if (distinct >= 3 || (a === d && b === c && a !== b)) pinned.add(i * (N + 1) + j)
  }
  return pinned
}

// 안쪽이 진행 방향 왼쪽에 오도록 칸 모서리를 방향지어 뽑고, 끝점을 이어 닫힌 고리를 만든다.
//
// 한 모서리에서 나가는 길이 둘일 때(같은 구역이 대각선으로만 맞닿는 자리) 아무거나 고르면
// 두 덩어리가 8자로 엮여 고리가 시작점으로 못 돌아온다. 안쪽이 왼쪽이므로 «왼쪽으로 꺾기»를
// 가장 먼저 시도하면 각 덩어리가 제 고리를 유지한다.
const TURN_ORDER = [
  (dx, dy) => [dy, -dx],   // 좌회전
  (dx, dy) => [dx, dy],    // 직진
  (dx, dy) => [-dy, dx],   // 우회전
  (dx, dy) => [-dx, -dy],  // 되돌아가기
]

function traceMask(predicate, N) {
  // 격자 밖은 «바깥»이다. 이 판정을 호출자에게 맡기면 grid[jy*N+ix] !== WATER 같은 술어가
  // 범위 밖에서 undefined !== -1 → true가 돼 맵 전체가 땅으로 둔갑한다 — 실제로 해안선이
  // 그렇게 통째로 사라졌다. 여기서 한 번 막으면 어떤 호출자도 그 실수를 못 한다.
  const inside = (ix, jy) => ix >= 0 && ix < N && jy >= 0 && jy < N && predicate(ix, jy)
  const key = (i, j) => i * (N + 1) + j
  const edges = new Map()
  const push = (a, b) => { const l = edges.get(a); if (l) l.push(b); else edges.set(a, [b]) }
  for (let jy = 0; jy < N; jy++) for (let ix = 0; ix < N; ix++) {
    if (!inside(ix, jy)) continue
    if (!inside(ix, jy - 1)) push(key(ix + 1, jy), key(ix, jy))
    if (!inside(ix, jy + 1)) push(key(ix, jy + 1), key(ix + 1, jy + 1))
    if (!inside(ix - 1, jy)) push(key(ix, jy), key(ix, jy + 1))
    if (!inside(ix + 1, jy)) push(key(ix + 1, jy + 1), key(ix + 1, jy))
  }
  const xy = k => [(k / (N + 1)) | 0, k % (N + 1)]
  const take = (cur, din) => {
    const nexts = edges.get(cur)
    if (!nexts?.length) return null
    let pick = 0
    if (din && nexts.length > 1) {
      const [cx, cy] = xy(cur)
      outer: for (const turn of TURN_ORDER) {
        const [wx, wy] = turn(din[0], din[1])
        for (let i = 0; i < nexts.length; i++) {
          const [nx, ny] = xy(nexts[i])
          if (nx - cx === wx && ny - cy === wy) { pick = i; break outer }
        }
      }
    }
    const next = nexts[pick]
    nexts.splice(pick, 1)
    if (!nexts.length) edges.delete(cur)
    return next
  }
  const loops = []
  for (const start of [...edges.keys()]) {
    while (edges.get(start)?.length) {
      const loop = []
      let cur = start, din = null, closed = false
      for (;;) {
        const next = take(cur, din)
        if (next === null) break
        loop.push(cur)
        const [ax, ay] = xy(cur), [bx, by] = xy(next)
        din = [bx - ax, by - ay]
        cur = next
        if (cur === start) { closed = true; break }
      }
      // 시작점으로 안 돌아온 고리는 버린다. 조용히 Z로 닫으면 구역을 가로지르는
      // 가짜 현이 생겨 이웃과 겹친다.
      if (closed && loop.length >= 4) loops.push(loop)
    }
  }
  return loops
}

const perpDist = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const len = Math.hypot(dx, dy)
  if (!len) return Math.hypot(p[0] - a[0], p[1] - a[1])
  return Math.abs(dy * (p[0] - a[0]) - dx * (p[1] - a[1])) / len
}

const lexLess = (a, b) => a[0] !== b[0] ? a[0] < b[0] : a[1] < b[1]

// 원본 대비 편차로 자른다(Douglas–Peucker). 앞서 «이웃 두 점만 보고 지우기»를 여러 번
// 돌려 봤는데, 한 번 깎인 결과를 다시 깎으니 편차가 눈덩이처럼 불어 구 하나가 삼각형이
// 됐다. 편차는 반드시 «원래 선»에서 재야 한다.
//
// 뒤집어도 같은 점이 뽑혀야 공유 경계가 어긋나지 않으므로, 동점은 좌표 사전순으로 깬다.
function douglasPeucker(pts, eps) {
  if (pts.length < 3) return pts.slice()
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const stack = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    if (b - a < 2) continue
    let bi = -1, bd = -1
    for (let i = a + 1; i < b; i++) {
      const d = perpDist(pts[i], pts[a], pts[b])
      if (d > bd + 1e-12 || (bi >= 0 && Math.abs(d - bd) <= 1e-12 && lexLess(pts[i], pts[bi]))) {
        bd = d; bi = i
      }
    }
    if (bi < 0 || bd < eps) continue
    keep[bi] = 1
    stack.push([a, bi], [bi, b])
  }
  const out = []
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i])
  return out
}

const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

// 채이킨. 양 끝은 그대로 두고 사이만 깎는다. 뒤집으면 결과도 그대로 뒤집힌 값이 나오는
// 연산이라, 공유 경계를 양쪽에서 따로 돌려도 같은 곡선이 된다.
function chaikinOpen(pts, passes) {
  let cur = pts
  for (let pass = 0; pass < passes; pass++) {
    if (cur.length < 3) break
    const out = [cur[0]]
    for (let i = 0; i + 1 < cur.length; i++) {
      out.push(lerp(cur[i], cur[i + 1], 0.25), lerp(cur[i], cur[i + 1], 0.75))
    }
    out.push(cur[cur.length - 1])
    cur = out
  }
  return cur
}

function chaikinClosed(pts, passes) {
  let cur = pts
  for (let pass = 0; pass < passes; pass++) {
    const n = cur.length
    if (n < 3) break
    const out = []
    for (let i = 0; i < n; i++) {
      const a = cur[i], b = cur[(i + 1) % n]
      out.push(lerp(a, b, 0.25), lerp(a, b, 0.75))
    }
    cur = out
  }
  return cur
}

// 고정점이 없는 고리(이웃 하나에 통째로 둘러싸인 구역)도 자를 기준점이 필요하다.
// 사전순 최소점과 그로부터 가장 먼 점 — 진행 방향과 무관하게 같은 두 점이 뽑힌다.
function syntheticAnchors(pts) {
  let lo = 0
  for (let i = 1; i < pts.length; i++) if (lexLess(pts[i], pts[lo])) lo = i
  let far = lo, fd = -1
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[lo][0], pts[i][1] - pts[lo][1])
    if (d > fd + 1e-12 || (Math.abs(d - fd) <= 1e-12 && lexLess(pts[i], pts[far]))) { fd = d; far = i }
  }
  return lo === far ? [lo] : [lo, far].sort((a, b) => a - b)
}

function loopsToPath(loops, N, pinned, { eps, passes, snap }) {
  const cell = 100 / N
  const subpaths = []
  for (const loop of loops) {
    const pts = loop.map(k => [((k / (N + 1)) | 0) * cell, (k % (N + 1)) * cell])
    let anchors = []
    if (pinned) for (let i = 0; i < loop.length; i++) if (pinned.has(loop[i])) anchors.push(i)
    const closedSmooth = anchors.length === 0
    if (closedSmooth) anchors = syntheticAnchors(pts)

    let out = []
    if (anchors.length < 2) {
      out = chaikinClosed(douglasPeucker(pts, eps), passes)
    } else {
      // 고정점 사이의 «호»마다 따로 자르고 깎는다. 이웃 구역도 같은 호를 같은 방식으로
      // 처리하므로 두 구역이 글자 그대로 같은 곡선을 얻는다 → 겹칠 수가 없다.
      const arcs = []
      for (let a = 0; a < anchors.length; a++) {
        const from = anchors[a], to = anchors[(a + 1) % anchors.length]
        const arc = []
        for (let i = from; ; i = (i + 1) % pts.length) {
          arc.push(pts[i])
          if (i === to) break
        }
        arcs.push(douglasPeucker(arc, eps))
      }
      if (closedSmooth) {
        // 진짜 고정점이 아니라 임의로 잡은 기준점이므로 모서리로 남기지 않는다.
        const merged = []
        for (const arc of arcs) for (let i = 0; i + 1 < arc.length; i++) merged.push(arc[i])
        out = chaikinClosed(merged, passes)
      } else {
        for (const arc of arcs) {
          const smooth = chaikinOpen(arc, passes)
          for (let i = 0; i + 1 < smooth.length; i++) out.push(smooth[i])
        }
      }
    }

    const snapped = []
    for (const [x, y] of out) {
      const sx = Math.round(x / snap) * snap, sy = Math.round(y / snap) * snap
      const last = snapped[snapped.length - 1]
      if (!last || last[0] !== sx || last[1] !== sy) snapped.push([sx, sy])
    }
    while (snapped.length > 1 && snapped[0][0] === snapped[snapped.length - 1][0]
      && snapped[0][1] === snapped[snapped.length - 1][1]) snapped.pop()
    if (snapped.length < 3) continue
    subpaths.push('M' + snapped.map(([x, y]) => `${round2(x)} ${round2(y)}`).join('L') + 'Z')
  }
  return subpaths.join('')
}

// 좌표 자릿수는 스냅 격자에서 따라온다 — 격자보다 잘게 적어 봐야 파일만 커진다.
const COORD_DECIMALS = MAP_TUNING.SNAP >= 0.1 ? 1 : 2
const round2 = v => {
  const f = 10 ** COORD_DECIMALS
  return Math.round(v * f) / f
}

// 등고선: 선형 보간 marching squares 후 끝점을 이어 폴리라인으로 붙인다.
// 조각마다 M을 찍으면 경로 문자열이 몇 배로 불어난다.
function isoLines(field, N, level) {
  const cell = 100 / N
  const segs = []
  const at = (i, j) => field[j * N + i]
  const pos = (i, j) => [(i + 0.5) * cell, (j + 0.5) * cell]
  const cross = (pa, va, pb, vb) => lerp(pa, pb, (level - va) / (vb - va || 1e-9))
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
    const v = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]
    const p = [pos(i, j), pos(i + 1, j), pos(i + 1, j + 1), pos(i, j + 1)]
    let code = 0
    for (let k = 0; k < 4; k++) if (v[k] >= level) code |= 1 << k
    if (code === 0 || code === 15) continue
    const edge = k => cross(p[k], v[k], p[(k + 1) % 4], v[(k + 1) % 4])
    const table = {
      1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 5: [[3, 0], [1, 2]], 6: [[0, 2]],
      7: [[3, 2]], 8: [[2, 3]], 9: [[2, 0]], 10: [[0, 1], [2, 3]], 11: [[2, 1]],
      12: [[1, 3]], 13: [[1, 0]], 14: [[0, 3]],
    }
    for (const [a, b] of table[code]) segs.push([edge(a), edge(b)])
  }
  return stitch(segs)
}

function stitch(segs) {
  const k = p => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`
  const heads = new Map()
  for (const s of segs) {
    const key = k(s[0])
    const l = heads.get(key)
    if (l) l.push(s); else heads.set(key, [s])
  }
  const used = new Set()
  const paths = []
  for (const seg of segs) {
    if (used.has(seg)) continue
    used.add(seg)
    const line = [seg[0], seg[1]]
    for (;;) {
      const next = (heads.get(k(line[line.length - 1])) ?? []).find(s => !used.has(s))
      if (!next) break
      used.add(next)
      line.push(next[1])
      if (line.length > 20000) break
    }
    if (line.length < 3) continue
    let len = 0
    for (let i = 1; i < line.length; i++) len += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1])
    if (len < MAP_TUNING.CONTOUR_MIN_LEN) continue
    const thin = douglasPeucker(line, MAP_TUNING.CONTOUR_EPS)
    if (thin.length < 3) continue
    paths.push('M' + thin.map(([x, y]) => `${round2(x)} ${round2(y)}`).join('L'))
  }
  return paths.join('')
}

// ─── 조립 ────────────────────────────────────────────────────────────────

const ringsOf = feature => feature.geometry.type === 'Polygon'
  ? feature.geometry.coordinates : feature.geometry.coordinates.flat()

function parseSubpaths(d) {
  return d.split('Z').filter(s => /\d/.test(s)).map(sub => {
    const nums = sub.match(/-?\d+(?:\.\d+)?/g).map(Number)
    const ring = []
    for (let i = 0; i + 1 < nums.length; i += 2) ring.push([nums[i], nums[i + 1]])
    return ring
  })
}

const inRing = (x, y, r) => {
  let hit = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}
const inPath = (x, y, rings) => rings.reduce((acc, r) => acc !== inRing(x, y, r), false)

async function buildCity(cityKey, { refresh, days, year, onProgress }) {
  const N = MAP_TUNING.GRID
  const cell = 100 / N
  const { project, unproject, stats } = fitProjection(cityKey)
  const city = CITIES[cityKey]

  // 1. 실측 승하차 → 역 유형 (PR #6의 분류기 그대로)
  onProgress?.(`${cityKey} 승하차 실측 불러오는 중`)
  const rides = cityKey === 'SEOUL'
    ? await loadSeoulRides({ days, refresh, onProgress })
    : await loadBusanRides({ year, refresh, onProgress })
  const scored = classifyStations(rides.stations)
  const typeOf = new Map()
  for (const s of scored) {
    const k = normName(s.name)
    const prev = typeOf.get(k)
    if (!prev || s.volume > prev.volume) typeOf.set(k, { type: s.type, volume: s.volume })
  }

  // 2. 역 좌표 → 맵 좌표
  const coords = await fetchStationCoords(cityKey, refresh, onProgress)
  const stations = []
  for (const [name, info] of typeOf) {
    const c = coords.get(name)
    if (!c) continue
    const [x, y] = project(c[0], c[1])
    stations.push({ name, kind: KINDS.indexOf(info.type), volume: info.volume, x, y })
  }

  // 3. 토지피복·시 경계·고도
  const cover = await fetchLandCover(cityKey, refresh, onProgress)
  const greenMask = rasterizeLandCover(cover, project, N, GREEN_TAGS)
  const waterMask = rasterizeLandCover(cover, project, N, WATER_TAGS)

  const gu = (await fetchGuBoundaries(refresh, onProgress)).features
    .filter(f => city.guPrefix.test(f.properties.code ?? ''))
  const cityMask = new Uint8Array(N * N)
  const guAt = new Int16Array(N * N).fill(-1)
  gu.forEach((f, gi) => {
    for (const ring of ringsOf(f)) {
      const pts = ring.map(([lon, lat]) => project(lon, lat))
      fillPolygon(cityMask, N, pts)
      fillPolygon(guAt, N, pts, gi)
    }
  })

  const elevate = await elevationSampler(refresh, onProgress)
  const elev = new Float32Array(N * N)
  for (let jy = 0; jy < N; jy++) {
    if (jy % 16 === 0) onProgress?.(`${cityKey} 고도 ${Math.round(jy / N * 100)}%`)
    for (let ix = 0; ix < N; ix++) {
      const [lon, lat] = unproject((ix + 0.5) * cell, (jy + 0.5) * cell)
      elev[jy * N + ix] = await elevate.at(lon, lat)
    }
  }

  // 4. 역 영향장 → 유형별 정규화 → argmax
  // 정규화가 없으면 역 수가 압도적인 주거(서울 153/271)가 전부를 삼킨다.
  onProgress?.(`${cityKey} 구역 분류 중`)
  const field = KINDS.map(() => new Float32Array(N * N))
  const lam = MAP_TUNING.LAMBDA_KM
  // 부산 맵은 가로가 세로보다 1.5배 늘어나 있다(0.52 vs 0.34 km/칸). 평균 하나로 재면
  // 동서 거리가 실제보다 가깝게 계산돼 역 영향이 옆 동네로 새어 나간다.
  const [kmX, kmY] = stats.kmPerUnit
  for (let jy = 0; jy < N; jy++) for (let ix = 0; ix < N; ix++) {
    const x = (ix + 0.5) * cell, y = (jy + 0.5) * cell
    for (const s of stations) {
      const d = Math.hypot((s.x - x) * kmX, (s.y - y) * kmY)
      field[s.kind][jy * N + ix] += Math.exp(-d / lam)
    }
  }

  const cls = new Int8Array(N * N)
  const isWater = i => !cityMask[i] || waterMask[i] || elev[i] <= 0
  const landElev = []
  for (let i = 0; i < N * N; i++) if (!isWater(i)) landElev.push(elev[i])
  landElev.sort((a, b) => a - b)
  const elevCut = Math.min(MAP_TUNING.ELEV_CUT_MAX_M, Math.max(MAP_TUNING.ELEV_CUT_MIN_M,
    Math.round(landElev[Math.floor(landElev.length * MAP_TUNING.ELEV_CUT_Q)] ?? MAP_TUNING.ELEV_CUT_MIN_M)))

  const built = []
  for (let i = 0; i < N * N; i++) {
    if (isWater(i)) { cls[i] = WATER; continue }
    if (greenMask[i] || elev[i] >= elevCut) { cls[i] = KINDS.indexOf('GREEN'); continue }
    built.push(i)
  }
  const means = field.map(f => { let s = 0; for (const i of built) s += f[i]; return s / (built.length || 1) || 1 })
  const meanTotal = means.reduce((a, b) => a + b, 0) || 1
  const residential = KINDS.indexOf('RESIDENTIAL')
  for (const i of built) {
    let total = 0
    for (let k = 0; k < 5; k++) total += field[k][i]
    if (total < MAP_TUNING.FIELD_FLOOR * meanTotal) { cls[i] = residential; continue }
    let best = residential, bv = -1
    for (let k = 0; k < 5; k++) {
      const lq = field[k][i] / means[k]
      if (lq > bv) { bv = lq; best = k }
    }
    cls[i] = best
  }

  // 5. 얼룩 제거 → 작은 덩어리 흡수
  const grid = majorityFilter(cls, N)
  absorbSmall(grid, N, Math.round(N * N * MAP_TUNING.MIN_BLOB))

  // 6. 벡터화. 구역·해안선·내수면이 «같은 격자·같은 고정점»에서 나오므로 서로 어긋나지 않는다.
  const pinned = junctionCorners(grid, N)
  const shape = { eps: MAP_TUNING.SHAPE_EPS, passes: 2, snap: MAP_TUNING.SNAP }
  const { comp, list } = components(grid, N)

  const usedNames = new Set()
  const districts = []
  for (const blob of list.sort((a, b) => b.cells.length - a.cells.length)) {
    const path = loopsToPath(traceMask((ix, jy) => comp[jy * N + ix] === blob.id, N), N, pinned, shape)
    if (!path) continue
    // 이름은 «그 안에서 가장 붐비는 역»에서 딴다. 자치구 최다 겹침으로 뽑아 봤더니
    // 남포가 «서 관광», 부산역이 «사하 녹지»가 됐다 — 큰 덩어리는 여러 구에 걸쳐서
    // 최다 겹침 구가 사람이 아는 지명과 어긋난다. 역 이름은 그럴 일이 없고, 이 게임에서
    // 제일 알아보기 쉬운 지명이기도 하다. 역이 없는 덩어리(산·외곽)만 구 이름으로 떨어진다.
    const cellSet = new Set(blob.cells)
    const inside = stations.filter(st => {
      const ix = (st.x / cell) | 0, jy = (st.y / cell) | 0
      return ix >= 0 && ix < N && jy >= 0 && jy < N && cellSet.has(jy * N + ix)
    }).sort((a, b) => b.volume - a.volume)
    // 그 구역이 «그 유형인 이유»가 된 역을 먼저 고른다. 거점 구역 안에도 주거역은 있다.
    let base = (inside.find(st => st.kind === blob.kind) ?? inside[0])?.name
    if (!base) {
      const tally = new Map()
      for (const p of blob.cells) {
        const g = guAt[p]
        if (g >= 0) tally.set(g, (tally.get(g) ?? 0) + 1)
      }
      const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]
      base = top ? gu[top[0]].properties.name : city.name
    }
    const kind = KINDS[blob.kind]
    let name = `${base} ${KIND_LABEL[kind]}`
    for (let n = 2; usedNames.has(name); n++) name = `${base} ${KIND_LABEL[kind]} ${n}`
    usedNames.add(name)
    districts.push({ name, kind, d: path, label: poleOfInaccessibility(blob.cells, N).map(round2) })
  }

  const coastline = loopsToPath(traceMask((ix, jy) => grid[jy * N + ix] !== WATER, N), N, pinned, shape)
  const water = loopsToPath(
    traceMask((ix, jy) => grid[jy * N + ix] === WATER && cityMask[jy * N + ix] === 1, N), N, pinned, shape)

  const bandShape = { eps: MAP_TUNING.SHAPE_EPS * 1.6, passes: 2, snap: MAP_TUNING.SNAP }
  const reliefBands = MAP_TUNING.RELIEF_M.map(minM => ({
    minM,
    d: loopsToPath(traceMask((ix, jy) => elev[jy * N + ix] >= minM && cityMask[jy * N + ix] === 1, N), N, null, bandShape),
  })).filter(b => b.d)
  const contours = MAP_TUNING.CONTOUR_M
    .map(elevM => ({ elevM, d: isoLines(elev, N, elevM) })).filter(c => c.d)

  // 7. 랜드마스크 (256×256, 1비트/칸, 행 우선, MSB 먼저)
  const bytes = new Uint8Array(N * N / 8)
  for (let i = 0; i < N * N; i++) if (grid[i] !== WATER) bytes[i >> 3] |= 128 >> (i & 7)

  const guLabels = gu.map((f, gi) => {
    const cells = []
    for (let i = 0; i < N * N; i++) if (guAt[i] === gi) cells.push(i)
    return cells.length < 12 ? null
      : { name: f.properties.name, at: poleOfInaccessibility(cells, N).map(round2) }
  }).filter(Boolean)

  const classification = {}
  for (const k of KINDS.slice(0, 5)) {
    classification[k] = scored.filter(s => s.type === k)
      .sort((a, b) => b.volume - a.volume).slice(0, 12).map(s => normName(s.name))
  }

  return {
    payload: {
      name: city.name,
      districts,
      guLabels,
      reliefBands,
      contours,
      water: water ? [water] : [],
      coastline,
      landMask: Buffer.from(bytes).toString('base64'),
    },
    meta: {
      projection: stats,
      classification,
      stationsUsed: stations.length,
      stationsClassified: scored.length,
      elevationTiles: elevate.count,
      elevCut,
      grid: N,
      areaPct: Object.fromEntries(KINDS.map((k, i) => {
        let n = 0
        for (const v of grid) if (v === i) n++
        return [k, Math.round(n / (N * N) * 1000) / 10]
      })),
    },
    grid,
  }
}

// 굽자마자 다시 센다. 겹침이 0이 아니면 쓰지 않는다 — 이 파일의 존재 이유가 그거다.
function auditDistricts(districts, grid, N) {
  const parsed = districts.map(d => {
    const rings = parseSubpaths(d.d)
    let bb = [Infinity, Infinity, -Infinity, -Infinity]
    for (const r of rings) for (const [x, y] of r) {
      bb = [Math.min(bb[0], x), Math.min(bb[1], y), Math.max(bb[2], x), Math.max(bb[3], y)]
    }
    return { rings, bb, name: d.name, cells: 0 }
  })
  let overlap = 0, landUncovered = 0, land = 0, coveredWater = 0, covered = 0
  const pairs = []
  const S = 256
  for (let jy = 0; jy < S; jy++) for (let ix = 0; ix < S; ix++) {
    const x = (ix + 0.5) * 100 / S, y = (jy + 0.5) * 100 / S
    const gi = Math.min(N - 1, (y * N / 100) | 0) * N + Math.min(N - 1, (x * N / 100) | 0)
    const isLand = grid[gi] !== WATER
    let hits = 0
    const who = []
    for (const p of parsed) {
      if (x < p.bb[0] || x > p.bb[2] || y < p.bb[1] || y > p.bb[3]) continue
      if (inPath(x, y, p.rings)) { hits++; p.cells++; who.push(p.name) }
    }
    if (isLand) land++
    if (hits > 1) {
      overlap++
      if (pairs.length < 6) pairs.push(`(${round2(x)},${round2(y)}) ${who.join(' × ')}`)
    }
    if (hits > 0) covered++
    if (isLand && hits === 0) landUncovered++
    if (!isLand && hits > 0) coveredWater++
  }
  return {
    overlap,
    pairs,
    gapPct: land ? Math.round(landUncovered / land * 1000) / 10 : 0,
    spillPct: covered ? Math.round(coveredWater / covered * 1000) / 10 : 0,
    empty: parsed.filter(p => !p.cells).map(p => p.name),
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : fallback
  }
  const refresh = argv.includes('--refresh')
  const days = Number(flag('days', 364))
  const year = Number(flag('year', 2024))
  const keys = String(flag('city', 'SEOUL,BUSAN')).split(',').filter(k => CITIES[k])
  const onProgress = msg => process.stderr.write(`\r${msg}`.padEnd(78))

  const cities = {}
  const meta = {}
  const audits = {}
  for (const key of keys) {
    const { payload, meta: m, grid } = await buildCity(key, { refresh, days, year, onProgress })
    cities[key] = payload
    meta[key] = m
    audits[key] = auditDistricts(payload.districts, grid, m.grid)
    process.stderr.write('\r'.padEnd(79) + '\r')
  }

  const failed = Object.entries(audits).filter(([, a]) => a.overlap > 0 || a.empty.length)
  if (failed.length) {
    for (const [key, a] of failed) {
      console.error(`${key}: 겹친 칸 ${a.overlap}, 빈 구역 [${a.empty.join(', ')}]`)
      for (const line of a.pairs) console.error(`   ${line}`)
    }
    const debugFile = path.join(CACHE_DIR, 'map-profile.debug.json')
    await mkdir(CACHE_DIR, { recursive: true })
    await writeFile(debugFile, JSON.stringify({ cities, meta, audits }, null, 1))
    console.error(`들여다볼 것: ${path.relative(process.cwd(), debugFile)}`)
    throw new Error('구역이 겹치거나 비었다. 쓰지 않는다.')
  }

  const profile = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString().slice(0, 10),
    source: {
      ridership: {
        note: 'build-demand-profile.mjs의 classifyStations()를 그대로 태운다',
        datasets: [
          { id: 'OA-12921', name: '서울교통공사_역별 일별 시간대별 승하차인원 정보', city: 'SEOUL' },
          { id: '3057229', name: '부산교통공사_시간대별 승하차인원', city: 'BUSAN' },
        ],
      },
      stations: { portal: 'OpenStreetMap Overpass', query: 'railway=station + subway', license: 'ODbL' },
      landcover: { portal: 'OpenStreetMap Overpass', query: 'landuse/leisure/natural', license: 'ODbL' },
      elevation: {
        name: 'AWS Open Data terrain-tiles (terrarium)',
        basis: 'SRTM 1 Arc-Second + GMTED2010',
        zoom: TERRAIN_Z,
        formula: 'R*256 + G + B/256 - 32768',
      },
      districtNames: {
        name: '통계청 센서스용 행정구역경계 (시군구, 2018)',
        via: 'github.com/southkorea/southkorea-maps kostat/2018',
        license: 'Free to share or remix',
      },
      projection: Object.fromEntries(Object.entries(meta).map(([k, m]) =>
        [k, { ...m.projection, elevCutM: m.elevCut, stationsUsed: m.stationsUsed }])),
      classification: Object.fromEntries(Object.entries(meta).map(([k, m]) => [k, m.classification])),
      tuning: MAP_TUNING,
    },
    cities,
  }

  await mkdir(path.dirname(OUT_FILE), { recursive: true })
  await writeFile(OUT_FILE, JSON.stringify(profile, null, 1) + '\n')

  const size = JSON.stringify(profile).length
  console.log(`\n${path.relative(process.cwd(), OUT_FILE)} — ${(size / 1024).toFixed(0)}KB`)
  for (const key of keys) {
    const m = meta[key], a = audits[key], c = cities[key]
    console.log(`\n■ ${key} (${c.name})`)
    console.log(`  투영     RMSE ${m.projection.rmseUnits}칸 · ${m.projection.kmPerUnit.join(' / ')} km/칸 · FIT_SCALE ${m.projection.fitScale}`)
    console.log(`  역       분류 ${m.stationsClassified}개 중 좌표 매칭 ${m.stationsUsed}개 · 고도 타일 ${m.elevationTiles}장`)
    console.log(`  녹지컷   ${m.elevCut}m (그 도시 땅의 상위 ${Math.round((1 - MAP_TUNING.ELEV_CUT_Q) * 100)}%)`)
    console.log(`  면적     ${KINDS.map(k => `${KIND_LABEL[k]} ${m.areaPct[k]}%`).join(' · ')}`)
    console.log(`  구역     ${c.districts.length}개 · 등고선 ${c.contours.length}단 · 고도대 ${c.reliefBands.length}단 · 구 라벨 ${c.guLabels.length}개`)
    console.log(`  ★ 겹친 칸 ${a.overlap} · 땅인데 빈 칸 ${a.gapPct}% · 물인데 덮인 칸 ${a.spillPct}%`)
    const byKind = {}
    for (const d of c.districts) (byKind[d.kind] ??= []).push(d.name)
    for (const k of KINDS) if (byKind[k]) console.log(`   ${KIND_LABEL[k]}  ${byKind[k].join(', ')}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error('\n' + err.stack); process.exit(1) })
}
