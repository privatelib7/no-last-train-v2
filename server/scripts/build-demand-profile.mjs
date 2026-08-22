#!/usr/bin/env node
// 공공데이터 → 시뮬레이션 수요 프로필(src/data/demand-profile.json)
//
//   node scripts/build-demand-profile.mjs [--days 364] [--year 2024] [--refresh]
//
// 게임 맵(City.mapKey)마다 그 도시의 실제 지하철 승하차를 쓴다.
//
//   SEOUL  서울열린데이터광장 «서울교통공사_역별 일별 시간대별 승하차인원 정보»(OA-12921)
//          인증키 없이 열려 있는 조회 엔드포인트. 1~8호선 271개 역.
//   BUSAN  부산 공공데이터포털 «부산교통공사_시간대별 승하차인원»(3057229)
//          연 단위 CSV(공공데이터포털 직접 내려받기). 1~4호선 112개 역.
//
// 여기에 더해 «어디서 어디로» 가는지를 실측 OD에서 뽑는다.
//   공공데이터포털 «서울특별시_지하철 역별 OD»(15113638) + «서울교통공사 역사 좌표»(15099316)
// 이 둘로 거리 감쇠 f(d)와 역 유형쌍 친화도를 추정한다. 자세한 한계는 analyzeOd() 주석 참고.
//
// 둘 다 «일별»이라 요일을 그대로 셀 수 있다 — 평일/주말 곡선을 추정 없이 실측으로 가른다.
// 만들어진 JSON은 커밋한다. 게임 실행 중에는 네트워크를 타지 않는다.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_DIR = path.join(ROOT, '.cache')
// 서버(시뮬레이션)와 클라이언트(화면 위 시민 동선)가 같은 곡선을 써야 해서 양쪽에 쓴다.
const OUT_FILES = [
  path.join(ROOT, 'src/data/demand-profile.json'),
  path.join(ROOT, '../client/src/data/demand-profile.json'),
]

const DATA_GO_KR = 'https://www.data.go.kr'
const OD_DATASET = '15113638'        // 서울특별시_지하철 역별 OD
const STATION_XY_DATASET = '15099316' // 서울교통공사_1_8호선 역사 좌표(위경도)

const TYPES = ['RESIDENTIAL', 'COMMERCIAL', 'TOURIST', 'INDUSTRIAL', 'HUB']
const DAY_TYPES = ['WEEKDAY', 'WEEKEND']

const zeros = () => new Array(24).fill(0)

// ─── 서울: 열린데이터광장 조회 API ───────────────────────────────────────

const SEOUL_DATA_VIEW = 'https://data.seoul.go.kr/dataList/dataView.do'
const SEOUL_DATASET = 'OA-12921'
const SEOUL_PAGE_ROWS = 1000
// 조회 엔드포인트의 pageNo는 «100행» 단위로 움직인다. onepagerow로 1000행을 받으면
// 다음 페이지는 pageNo+10이다. 그냥 +1 하면 900행이 겹쳐 들어온다.
const SEOUL_PAGE_STEP = SEOUL_PAGE_ROWS / 100

// 원본 칸 → 게임 시(0~23). HR24는 24시대(자정~01시)라 0시로 접는다.
const SEOUL_HOUR_COLUMNS = [
  ['HR06_BFR', 5], ['HR06', 6], ['HR07', 7], ['HR08', 8], ['HR09', 9], ['HR10', 10],
  ['HR11', 11], ['HR12', 12], ['HR13', 13], ['HR14', 14], ['HR15', 15], ['HR16', 16],
  ['HR17', 17], ['HR18', 18], ['HR19', 19], ['HR20', 20], ['HR21', 21], ['HR22', 22],
  ['HR23', 23], ['HR24', 0],
]

// 응답이 순수 JSON이 아니다. 키에 따옴표가 없고 배열 끝에 쉼표가 남는다.
// 문자열 안/밖을 구분해 훑으면서 키만 따옴표로 감싸고 트레일링 쉼표를 지운다.
export function parseLooseJson(text) {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === '\\') { out += text[++i] ?? '' }
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; out += ch; continue }
    if (ch === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === '}' || text[j] === ']') continue  // 트레일링 쉼표
    }
    out += ch
    if (ch === ',' || ch === '{') {
      const m = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*):/.exec(text.slice(i + 1))
      if (m) { out += `${m[1]}"${m[2]}"${m[3]}:`; i += m[0].length }
    }
  }
  return JSON.parse(out)
}

async function cached(file, refresh, produce) {
  const full = path.join(CACHE_DIR, file)
  if (!refresh && existsSync(full)) return readFile(full)
  const body = await produce()
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, body)
  return body
}

async function fetchSeoulPage(pageNo, refresh) {
  const buf = await cached(`seoul-open-data/${SEOUL_DATASET}/p${pageNo}.json`, refresh, async () => {
    const url = new URL(SEOUL_DATA_VIEW)
    for (const [k, v] of Object.entries({
      onepagerow: SEOUL_PAGE_ROWS, srvType: 'S', infId: SEOUL_DATASET, serviceKind: '1',
      pageNo, ssUserId: 'SAMPLE_VIEW', strWhere: '', strOrderby: '',
    })) url.searchParams.set(k, String(v))

    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) throw new Error(`${SEOUL_DATASET} p${pageNo}: HTTP ${res.status}`)
    const parsed = parseLooseJson(await res.text())
    if (parsed.result !== 'ok') throw new Error(`${SEOUL_DATASET} p${pageNo}: ${JSON.stringify(parsed).slice(0, 200)}`)
    return Buffer.from(JSON.stringify(parsed))
  })
  return JSON.parse(buf.toString('utf8'))
}

// 데이터셋 앞에서부터 days일치를 모은다(원본은 2024-01-01부터 실린다).
export async function loadSeoulRides({ days, refresh, onProgress }) {
  const rows = new Map()   // 중복 방지 키 → row
  const dates = new Set()

  for (let pageNo = 1; ; pageNo += SEOUL_PAGE_STEP) {
    const page = await fetchSeoulPage(pageNo, refresh)
    if (!page.list.length) break
    for (const row of page.list) {
      rows.set(`${row.MVMN_YMD}|${row.LINE}|${row.STTN}|${row.GTNF_SE}`, row)
      dates.add(row.MVMN_YMD)
    }
    onProgress?.(`p${pageNo} · ${dates.size}일 · ${rows.size}행`)
    if (dates.size > days) break
  }

  // 마지막 날짜는 페이지 경계에서 잘렸을 수 있어 버린다.
  const usable = new Set([...dates].sort().slice(0, days))
  return collectRides({
    usable,
    rows: rows.values(),
    dateOf: row => row.MVMN_YMD,
    keyOf: row => `${row.LINE}|${row.STTN}`,
    stationOf: row => ({ line: row.LINE, name: row.STTN }),
    isAlighting: row => row.GTNF_SE === '하차',
    hoursOf: row => SEOUL_HOUR_COLUMNS.map(([col, hour]) => [hour, Number(row[col] || 0)]),
  })
}

// ─── 부산: 공공데이터포털 연 단위 CSV ────────────────────────────────────

const BUSAN_PORTAL = 'https://data.busan.go.kr/bdip/opendata/selectFileData.do'
const BUSAN_DATASET_PK = '3057229'
// '01시-02시' … '23시-24시', '24시-01시' → 게임 시(0~23)
const BUSAN_HOUR_COLUMN = header => {
  const m = /^(\d{2})시-\d{2}시$/.exec(header)
  return m ? Number(m[1]) % 24 : null
}

// 포털에서 그 해의 전체 파일(제목이 …_YYYY1231)을 찾아 내려받는다.
// 파일 id가 갱신될 때마다 바뀌므로 하드코딩하지 않고 매번 목록에서 고른다.
async function resolveBusanFile(year) {
  const res = await fetch(BUSAN_PORTAL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicdatapk: BUSAN_DATASET_PK }),
  })
  if (!res.ok) throw new Error(`부산 파일 목록: HTTP ${res.status}`)
  const { fileList } = await res.json()
  const exact = fileList.find(f => f.title?.endsWith(`${year}1231`))
  const found = exact ?? fileList.find(f => f.title?.includes(String(year)))
  if (!found) {
    const titles = fileList.map(f => f.title).join(', ')
    throw new Error(`부산 ${year}년 파일이 없다. 있는 것: ${titles}`)
  }
  return found
}

async function loadBusanRides({ year, refresh, onProgress }) {
  const file = await resolveBusanFile(year)
  onProgress?.(`${file.title} (${file.mediaCnt}행) 내려받는 중`)
  const buf = await cached(`busan-open-data/${file.title}.csv`, refresh, async () => {
    const res = await fetch(file.downurl)
    if (!res.ok) throw new Error(`부산 CSV: HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  })

  // 공공데이터포털이 UTF-8이라고 알려 주지만 실제 내용은 CP949(EUC-KR)다.
  const text = new TextDecoder('euc-kr').decode(buf)
  const lines = text.split(/\r?\n/).filter(Boolean)
  const header = lines[0].split(',')
  const col = name => header.indexOf(name)
  const hourColumns = header
    .map((h, i) => [BUSAN_HOUR_COLUMN(h), i])
    .filter(([hour]) => hour !== null)
  const idx = {
    no: col('역번호'), name: col('역명'), date: col('년월일'),
    dow: col('요일'), kind: col('구분'),
  }
  if (Object.values(idx).some(v => v < 0) || hourColumns.length !== 24) {
    throw new Error(`부산 CSV 열 구성이 바뀌었다: ${header.join(',')}`)
  }

  const rows = lines.slice(1).map(line => line.split(','))
  const usable = new Set(rows.map(r => r[idx.date]))
  onProgress?.(`${usable.size}일 · ${rows.length}행`)

  return collectRides({
    usable,
    rows,
    dateOf: r => r[idx.date],
    keyOf: r => r[idx.no],
    // 부산 원본에는 호선 열이 없다. 역번호 백의 자리가 호선이다(095~134=1호선).
    stationOf: r => ({ line: `${Math.max(1, Math.floor(Number(r[idx.no]) / 100))}호선`, name: r[idx.name] }),
    isAlighting: r => r[idx.kind] === '하차',
    hoursOf: r => hourColumns.map(([hour, i]) => [hour, Number(r[i] || 0)]),
  })
}

// ─── OD: 어디서 어디로 가는가 ────────────────────────────────────────────

// 공공데이터포털 파일 데이터는 갱신될 때마다 첨부파일 id가 바뀐다. 상세 페이지에서 매번 긁는다.
async function resolveDataGoKrFile(datasetId) {
  const res = await fetch(`${DATA_GO_KR}/data/${datasetId}/fileData.do`)
  if (!res.ok) throw new Error(`${datasetId} 상세 페이지: HTTP ${res.status}`)
  const html = await res.text()
  const id = html.match(/FILE_\d+/)?.[0]
  if (!id) throw new Error(`${datasetId}: 첨부파일 id를 찾지 못했다`)
  const title = html.match(/데이터명[\s\S]{0,200}?>([^<]*_\d{8})</)?.[1]?.trim()
  return { id, title }
}

// 공공데이터포털 CSV는 헤더가 UTF-8이라고 하지만 실제 내용은 CP949다.
async function fetchDataGoKrCsv(datasetId, cacheName, refresh) {
  const file = await resolveDataGoKrFile(datasetId)
  const buf = await cached(`data-go-kr/${cacheName}.csv`, refresh, async () => {
    const res = await fetch(`${DATA_GO_KR}/cmm/cmm/fileDownload.do?atchFileId=${file.id}&fileDetailSn=1`)
    if (!res.ok) throw new Error(`${datasetId} 다운로드: HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  })
  const lines = new TextDecoder('euc-kr').decode(buf).split(/\r?\n/).filter(Boolean)
  const header = lines[0].split(',')
  return {
    title: file.title,
    rows: lines.slice(1).map(l => {
      const c = l.split(',')
      return Object.fromEntries(header.map((h, i) => [h, c[i]]))
    }),
  }
}

const EARTH_KM = 6371
const rad = deg => (deg * Math.PI) / 180
function haversineKm(a, b) {
  const dLat = rad(b[0] - a[0])
  const dLon = rad(b[1] - a[1])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h))
}

// 역명 표기가 데이터셋마다 달라서(«서울역»/«서울», «교대(법원.검찰청)»/«교대») 괄호와 끝 «역»을 떼고 맞춘다.
const normStation = name => name.replace(/\(.*?\)/g, '').replace(/역$/, '').trim()
const seoulLineNo = name => /^(\d)호선$/.exec(name)?.[1] ?? null

/**
 * 실측 OD에서 두 가지를 뽑는다.
 *
 *   1) 거리 감쇠 f(d) — 사람이 얼마나 멀리까지 가는가
 *   2) 역 유형쌍 친화도 — 거리와 역 규모를 걷어내고 «주거→업무» 같은 선호가 얼마나 남는가
 *
 * 친화도는 이중제약 중력모형(IPF)으로 잰다. T_ij = A_i·B_j·O_i·D_j·f(d_ij)를 행·열 합이
 * 실측과 같아질 때까지 조정하면, 역이 크다는 이유나 가깝다는 이유는 기대치에 다 흡수되고
 * 남는 편차만이 «유형 때문»이다. 이 절차 없이 재면 지리적 군집이 유형 선호로 둔갑한다.
 *
 * 한계: 공개된 역간 OD는 하루치(일요일)뿐이라 «평일» 친화도는 잴 수 없다. 평일은
 * 친화도 없이(=1.0) 거리 감쇠와 시간대별 주변분포만 쓴다. 둘 다 평일 실측이라 근거는 있다.
 */
export function analyzeOd({ trips, coords, typeOf }) {
  const total = trips.reduce((acc, t) => acc + t.n, 0)
  const O = new Map()
  const D = new Map()
  for (const t of trips) {
    O.set(t.from, (O.get(t.from) ?? 0) + t.n)
    D.set(t.to, (D.get(t.to) ?? 0) + t.n)
  }
  const keys = [...new Set([...O.keys(), ...D.keys()])].filter(k => coords.has(k) && typeOf.has(k))

  // 1) 억제함수 f(d) = 관측 / 독립가정 기대. 2km 구간으로 묶어 지수형을 가중 최소제곱 적합.
  const BIN = 2
  const BINS = 25
  const obs = new Array(BINS).fill(0)
  const exp = new Array(BINS).fill(0)
  const bin = km => Math.min(BINS - 1, Math.floor(km / BIN))
  for (const t of trips) if (coords.has(t.from) && coords.has(t.to)) obs[bin(t.km)] += t.n
  for (const i of keys) for (const j of keys) {
    exp[bin(haversineKm(coords.get(i), coords.get(j)))] += ((O.get(i) ?? 0) * (D.get(j) ?? 0)) / total
  }
  const pts = []
  for (let b = 0; b < BINS; b++) {
    if (exp[b] > total * 1e-4 && obs[b] > 0) pts.push({ d: b * BIN + BIN / 2, y: Math.log(obs[b] / exp[b]), w: obs[b] })
  }
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0
  for (const p of pts) { sw += p.w; sx += p.w * p.d; sy += p.w * p.y; sxx += p.w * p.d * p.d; sxy += p.w * p.d * p.y }
  const slope = (sw * sxy - sx * sy) / (sw * sxx - sx * sx)
  const intercept = (sy - slope * sx) / sw
  let ssRes = 0, ssTot = 0
  const yMean = sy / sw
  for (const p of pts) { ssRes += p.w * (p.y - (intercept + slope * p.d)) ** 2; ssTot += p.w * (p.y - yMean) ** 2 }
  const d0Km = -1 / slope

  const meanKm = trips.reduce((acc, t) => acc + t.km * t.n, 0) / total
  const sorted = [...trips].sort((a, b) => a.km - b.km)
  let acc = 0
  let medianKm = 0
  for (const t of sorted) { acc += t.n; if (acc >= total / 2) { medianKm = t.km; break } }

  // 2) IPF로 균형 잡은 기대치 대비 유형쌍 편차
  const Ov = keys.map(k => O.get(k) ?? 0)
  const Dv = keys.map(k => D.get(k) ?? 0)
  const F = keys.map(i => keys.map(j => Math.exp(-haversineKm(coords.get(i), coords.get(j)) / d0Km)))
  const A = new Array(keys.length).fill(1)
  const B = new Array(keys.length).fill(1)
  for (let iter = 0; iter < 60; iter++) {
    for (let i = 0; i < keys.length; i++) {
      let s = 0
      for (let j = 0; j < keys.length; j++) s += B[j] * Dv[j] * F[i][j]
      A[i] = s > 0 ? 1 / s : 0
    }
    for (let j = 0; j < keys.length; j++) {
      let s = 0
      for (let i = 0; i < keys.length; i++) s += A[i] * Ov[i] * F[i][j]
      B[j] = s > 0 ? 1 / s : 0
    }
  }
  const seen = new Set(keys)
  const cell = {}
  const expected = {}
  for (const a of TYPES) { cell[a] = {}; expected[a] = {}; for (const b of TYPES) { cell[a][b] = 0; expected[a][b] = 0 } }
  for (const t of trips) if (seen.has(t.from) && seen.has(t.to)) cell[typeOf.get(t.from)][typeOf.get(t.to)] += t.n
  for (let i = 0; i < keys.length; i++) for (let j = 0; j < keys.length; j++) {
    expected[typeOf.get(keys[i])][typeOf.get(keys[j])] += A[i] * Ov[i] * B[j] * Dv[j] * F[i][j]
  }
  const affinity = Object.fromEntries(TYPES.map(a => [a, Object.fromEntries(TYPES.map(b => {
    const e = expected[a][b]
    return [b, e > 0 ? round(cell[a][b] / e, 3) : 1]
  }))]))

  return {
    deterrence: { form: 'exp(-d/d0)', d0Km: round(d0Km, 2), r2: round(1 - ssRes / ssTot, 3) },
    tripKm: { mean: round(meanKm, 2), median: round(medianKm, 2) },
    affinity,
    passengers: total,
    pairs: trips.length,
  }
}

async function loadSeoulOd({ rides, refresh, onProgress }) {
  onProgress?.('역 좌표')
  const xy = await fetchDataGoKrCsv(STATION_XY_DATASET, 'seoul-station-xy', refresh)
  const coords = new Map()
  for (const r of xy.rows) {
    if (!r['위도'] || !r['경도']) continue
    coords.set(`${r['호선']}|${normStation(r['역명'])}`, [Number(r['위도']), Number(r['경도'])])
  }

  onProgress?.('역별 OD')
  const od = await fetchDataGoKrCsv(OD_DATASET, 'seoul-station-od', refresh)

  const typeOf = new Map()
  for (const s of classifyStations(rides.stations)) {
    typeOf.set(`${s.line.replace('호선', '')}|${normStation(s.name)}`, s.type)
  }

  const trips = []
  for (const r of od.rows) {
    const lf = seoulLineNo(r['승차_호선'])
    const lt = seoulLineNo(r['하차_호선'])
    if (!lf || !lt) continue  // 1~8호선만 좌표·유형이 있다
    const from = `${lf}|${normStation(r['승차_역'])}`
    const to = `${lt}|${normStation(r['하차_역'])}`
    const n = Number(r['총_승객수']) || 0
    if (n <= 0 || !coords.has(from) || !coords.has(to)) continue
    trips.push({ from, to, n, km: haversineKm(coords.get(from), coords.get(to)) })
  }
  onProgress?.(`${trips.length}쌍 매칭`)

  const dates = [...new Set(od.rows.map(r => r['기준일자']).filter(Boolean))].sort()
  return {
    result: analyzeOd({ trips, coords, typeOf }),
    source: {
      portal: '공공데이터포털 (data.go.kr)',
      datasets: [
        { id: OD_DATASET, name: '서울특별시_지하철 역별 OD', file: od.title },
        { id: STATION_XY_DATASET, name: '서울교통공사_1_8호선 역사 좌표(위경도) 정보', file: xy.title },
      ],
      span: dates.length === 1 ? dates[0] : `${dates[0]} ~ ${dates[dates.length - 1]}`,
    },
  }
}

// ─── 공통: 행 → 역 × 요일 × 시간 집계 ───────────────────────────────────

function collectRides({ usable, rows, dateOf, keyOf, stationOf, isAlighting, hoursOf }) {
  const dayCount = new Array(7).fill(0)
  const dateDow = new Map()
  for (const ymd of usable) {
    const [y, m, d] = ymd.split('-').map(Number)
    const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7  // 0=월 … 6=일
    dateDow.set(ymd, dow)
    dayCount[dow]++
  }

  const stations = new Map()
  const datesPerStation = new Map()
  for (const row of rows) {
    const dow = dateDow.get(dateOf(row))
    if (dow === undefined) continue
    const key = keyOf(row)
    let st = stations.get(key)
    if (!st) {
      st = { ...stationOf(row), dow: Array.from({ length: 7 }, () => ({ on: zeros(), off: zeros() })) }
      stations.set(key, st)
      datesPerStation.set(key, new Set())
    }
    datesPerStation.get(key).add(dateOf(row))
    const target = st.dow[dow][isAlighting(row) ? 'off' : 'on']
    for (const [hour, value] of hoursOf(row)) target[hour] += value
  }

  // 기간 내내 기록이 있는 역만 남긴다 (개통·개명으로 곡선이 튀지 않게)
  const complete = [...stations.entries()]
    .filter(([key]) => datesPerStation.get(key).size === usable.size)
    .map(([, st]) => st)

  return {
    stations: complete.length ? complete : [...stations.values()],
    dayCount,
    dates: [...usable].sort(),
  }
}

// ─── 역 유형 분류 ────────────────────────────────────────────────────────

const sumRange = (arr, from, to) => {
  let s = 0
  for (let h = from; h <= to; h++) s += arr[h % 24]
  return s
}

// 게임의 역 타입(주거·상업·관광·산업·거점)은 실제 데이터에 라벨로 없다. 승하차가 하루 중
// 언제 몰리는지로 실제 역을 유형에 대응시키고, 그 유형의 평균 곡선을 게임에 쓴다.
export function classifyStations(stations) {
  const scored = stations.map(s => {
    const on = zeros(); const off = zeros(); const weekendOn = zeros()
    for (let d = 0; d < 5; d++) {
      for (let h = 0; h < 24; h++) { on[h] += s.dow[d].on[h]; off[h] += s.dow[d].off[h] }
    }
    for (let h = 0; h < 24; h++) weekendOn[h] += s.dow[5].on[h] + s.dow[6].on[h]
    const totOn = sumRange(on, 0, 23) || 1
    const totOff = sumRange(off, 0, 23) || 1
    const totWeekendOn = sumRange(weekendOn, 0, 23) || 1
    return {
      ref: s, line: s.line, name: s.name,
      volume: totOn + totOff,
      amDepart: sumRange(on, 7, 9) / totOn,      // 아침에 나간다 → 주거지
      amArrive: sumRange(off, 7, 9) / totOff,    // 아침에 도착한다 → 업무지구
      // 주말에도 사람이 몰리는 곳 → 관광·여가지 (요일 수가 달라 하루 평균끼리 비교)
      weekendPull: (totWeekendOn / 2) / (totOn / 5),
    }
  })
  const cut = (key, q) => {
    const v = scored.map(s => s[key]).sort((a, b) => a - b)
    return v[Math.min(v.length - 1, Math.floor(v.length * q))]
  }
  const hubCut = cut('volume', 0.95)
  const touristCut = cut('weekendPull', 0.88)
  const industrialCut = cut('weekendPull', 0.12)

  for (const s of scored) {
    // 거점: 승하차 총량 상위. 실제로도 환승·광역 결절점이다.
    if (s.volume >= hubCut) s.type = 'HUB'
    // 관광·여가: 주말 하루 이용객이 평일 대비 가장 덜 빠지는 쪽
    else if (s.weekendPull >= touristCut) s.type = 'TOURIST'
    // 산업: 아침에 사람이 «들어오고» 주말엔 텅 비는 곳 (공단·오피스단지)
    else if (s.amArrive > s.amDepart && s.weekendPull <= industrialCut) s.type = 'INDUSTRIAL'
    // 상업·업무: 아침 하차가 승차보다 뚜렷하게 많은 나머지
    else if (s.amArrive - s.amDepart > 0.04) s.type = 'COMMERCIAL'
    else s.type = 'RESIDENTIAL'
  }
  return scored
}

// ─── 프로필 조립 ─────────────────────────────────────────────────────────

const round = (v, d) => { const f = 10 ** d; return Math.round(v * f) / f }
const total = arr => arr.reduce((a, b) => a + b, 0)

// 역 유형별 «하루 평균» 승하차 곡선 (역 1곳 기준)
function typeCurves(list, dayCount) {
  const out = {}
  for (const dayType of DAY_TYPES) {
    const dows = dayType === 'WEEKDAY' ? [0, 1, 2, 3, 4] : [5, 6]
    const days = dows.reduce((a, d) => a + dayCount[d], 0) || 1
    const on = zeros(); const off = zeros()
    for (const s of list) {
      for (const d of dows) {
        for (let h = 0; h < 24; h++) { on[h] += s.ref.dow[d].on[h]; off[h] += s.ref.dow[d].off[h] }
      }
    }
    const perStationDay = days * (list.length || 1)
    out[dayType] = { on: on.map(v => v / perStationDay), off: off.map(v => v / perStationDay) }
  }
  return out
}

export function buildCityProfile({ stations, dayCount, dates }, source) {
  const classified = classifyStations(stations)
  const byType = new Map(TYPES.map(t => [t, classified.filter(s => s.type === t)]))
  for (const [type, list] of byType) {
    if (list.length === 0) throw new Error(`${source.city}: ${type} 유형에 걸린 역이 없다`)
  }
  const curves = Object.fromEntries(TYPES.map(t => [t, typeCurves(byType.get(t), dayCount)]))

  // 기준 단위: 평일 하루, 역 1곳, 시간 1칸의 평균 승차 인원. 모든 가중치가 이 값 대비 배율이다.
  // 도시마다 따로 잡으므로 게임에는 «부산의 절대 승객 수»가 아니라 «부산의 곡선 모양»이 들어간다.
  const counts = TYPES.map(t => byType.get(t).length)
  const totalStations = counts.reduce((a, b) => a + b, 0)
  const unit = TYPES.reduce((acc, t, i) => acc + total(curves[t].WEEKDAY.on) * counts[i], 0) / (totalStations * 24)

  const scale = arr => arr.map(v => round(v / unit, 4))
  const origin = {}; const dest = {}
  for (const t of TYPES) {
    origin[t] = Object.fromEntries(DAY_TYPES.map(d => [d, scale(curves[t][d].on)]))
    dest[t] = Object.fromEntries(DAY_TYPES.map(d => [d, scale(curves[t][d].off)]))
  }
  const hourly = Object.fromEntries(DAY_TYPES.map(d => {
    const out = zeros()
    TYPES.forEach((t, i) => { for (let h = 0; h < 24; h++) out[h] += origin[t][d][h] * counts[i] })
    return [d, out.map(v => round(v / totalStations, 4))]
  }))

  // 요일 배율. 평일 5개는 평일 평균 대비, 토·일은 주말 평균 대비.
  // 평일↔주말 수준 차이는 hourly 곡선에 이미 들어 있으므로 여기서 또 곱하지 않는다.
  const dayTotals = new Array(7).fill(0)
  for (const s of classified) {
    for (let d = 0; d < 7; d++) dayTotals[d] += total(s.ref.dow[d].on) / (dayCount[d] || 1)
  }
  const weekdayMean = dayTotals.slice(0, 5).reduce((a, b) => a + b, 0) / 5
  const weekendMean = (dayTotals[5] + dayTotals[6]) / 2
  const dayOfWeek = dayTotals.map((v, i) => round(v / (i < 5 ? weekdayMean : weekendMean), 4))

  return {
    source: {
      ...source,
      span: `${dates[0]} ~ ${dates[dates.length - 1]} (${dates.length}일)`,
      dayCount,
      stationsUsed: totalStations,
    },
    // 실제 역을 승하차 시간대 모양으로 게임 역 타입에 대응시킨 결과 (사람이 눈으로 검증하는 용도)
    classification: Object.fromEntries(TYPES.map(t => [t, {
      count: byType.get(t).length,
      examples: [...byType.get(t)].sort((a, b) => b.volume - a.volume).slice(0, 8).map(s => `${s.line} ${s.name}`),
    }])),
    dayOfWeek,
    // 평일 하루·역 1곳·시간 1칸 평균 승차 = 1.0 기준 배율
    hourly,
    origin,
    dest,
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────

async function main() {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`)
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
  }
  const days = Number(arg('days', 364))
  const year = Number(arg('year', 2024))
  const refresh = process.argv.includes('--refresh')
  const progress = tag => msg => process.stderr.write(`\r  ${tag} ${msg}`.padEnd(70))

  console.log(`서울 — 열린데이터광장 ${SEOUL_DATASET}, ${days}일치`)
  const seoulRides = await loadSeoulRides({ days, refresh, onProgress: progress(SEOUL_DATASET) })
  const seoul = buildCityProfile(
    seoulRides,
    {
      city: 'SEOUL',
      portal: '서울열린데이터광장 (data.seoul.go.kr)',
      dataset: { id: SEOUL_DATASET, name: '서울교통공사_역별 일별 시간대별 승하차인원 정보' },
      note: '원본 시간대 칸은 06시 이전/06~24시라 01~04시가 비어 있다(지하철 미운행). 로더가 심야 최저치로 채운다.',
    },
  )
  process.stderr.write('\n')

  console.log(`부산 — 공공데이터포털 ${BUSAN_DATASET_PK}, ${year}년 전체`)
  const busan = buildCityProfile(
    await loadBusanRides({ year, refresh, onProgress: progress('CSV') }),
    {
      city: 'BUSAN',
      portal: '부산 공공데이터포털 (data.busan.go.kr) · 파일 원본은 공공데이터포털',
      dataset: { id: BUSAN_DATASET_PK, name: '부산교통공사_시간대별 승하차인원' },
      note: '원본은 01시부터 24시까지 24칸이 다 있다. 심야 칸은 값이 0에 가깝고 로더가 최저치로 올린다.',
    },
  )
  process.stderr.write('\n')

  console.log('OD — 공공데이터포털 15113638 (역간 통행) + 15099316 (역 좌표)')
  const od = await loadSeoulOd({ rides: seoulRides, refresh, onProgress: progress('OD') })
  process.stderr.write('\n')

  const profile = {
    schema: 'no-last-train/demand-profile@3',
    generatedAt: new Date().toISOString().slice(0, 10),
    // 목적지 선택 — 어디서 어디로 가는가. 서울 실측으로 재고 두 맵이 함께 쓴다
    // (부산은 공개된 역간 OD가 없다. 자세한 근거는 analyzeOd() 주석 참고).
    od: { source: od.source, ...od.result },
    cities: { SEOUL: seoul, BUSAN: busan },
  }
  for (const file of OUT_FILES) {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(profile, null, 2) + '\n')
  }

  for (const [key, city] of Object.entries(profile.cities)) {
    console.log(`\n[${key}] ${city.source.span} · 역 ${city.source.stationsUsed}곳`)
    for (const t of TYPES) {
      const c = city.classification[t]
      console.log(`  ${t.padEnd(12)} ${String(c.count).padStart(3)}곳 — ${c.examples.slice(0, 6).map(s => s.split(' ').slice(1).join(' ')).join(', ')}`)
    }
    console.log(`  요일 배율(월~일) ${city.dayOfWeek.map(v => v.toFixed(2)).join(' ')}`)
    console.log(`  주말/평일 총수요 ${(total(city.hourly.WEEKEND) / total(city.hourly.WEEKDAY)).toFixed(3)}`)
    console.log(`  평일 ${city.hourly.WEEKDAY.map(v => v.toFixed(1).padStart(4)).join('')}`)
    console.log(`  주말 ${city.hourly.WEEKEND.map(v => v.toFixed(1).padStart(4)).join('')}`)
  }
  const { deterrence, tripKm, affinity } = profile.od
  console.log(`\n[OD] ${od.source.span} · ${profile.od.pairs.toLocaleString()}쌍 / ${profile.od.passengers.toLocaleString()}명`)
  console.log(`  거리 감쇠 ${deterrence.form}  d0=${deterrence.d0Km}km  R²=${deterrence.r2}`)
  console.log(`  통행거리 평균 ${tripKm.mean}km · 중앙 ${tripKm.median}km`)
  console.log('  유형쌍 친화도 (거리·역규모 통제 후, 1.0이면 유형 선호 없음)')
  console.log('    출발\\도착 ', TYPES.map(t => t.slice(0, 4).padStart(7)).join(''))
  for (const a of TYPES) {
    console.log(`    ${a.padEnd(10)}`, TYPES.map(b => affinity[a][b].toFixed(2).padStart(7)).join(''))
  }
  console.log('')
  for (const file of OUT_FILES) console.log(`→ ${path.relative(process.cwd(), file)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1) })
}
