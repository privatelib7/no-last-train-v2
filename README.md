# 막차는 없다 (No Last Train)

친구들과 하나의 지하철 도시를 나눠 운영하는 비동기 협동 방치형 게임이다.

## 구조

```text
client/   # Vite + React 프론트엔드
server/   # Next.js API 서버 + 실시간 WebSocket 스크립트
deploy/   # nginx 설정 · 배포 스크립트 (publish.sh)
```

실행 시 보통 아래가 함께 돌아간다.

| 구성 | 역할 |
|------|------|
| **PostgreSQL** | 도시·플레이어·틱·경제 등 정본 저장소 |
| **Redis** (선택) | 실시간 차량 모션 베이스 캐시 + pub/sub. 없으면 API/실시간 서버가 PostgreSQL로 폴백 |
| **API 서버** (`nlt-server`) | `/api/*` HTTP API (Next.js) |
| **실시간 서버** (`nlt-realtime`) | `/ws` WebSocket — 차량 좌표·도시 스냅샷 push (`server/scripts/realtime-server.ts`) |
| **프론트** | Vite(dev) 또는 nginx 정적 파일(prod) |

Redis는 PostgreSQL을 대체하지 않는다. 연결이 없거나 끊겨도 동작은 유지되고, 모션만 DB 조회로 내려간다.

## 로컬 실행

### 1. 의존성

```bash
npm install
```

### 2. PostgreSQL

```bash
docker run -d \
  --name nlt-postgres \
  -e POSTGRES_USER=nlt \
  -e POSTGRES_PASSWORD=nlt \
  -e POSTGRES_DB=no_last_train \
  -p 5432:5432 \
  postgres:16
```

이미 컨테이너가 있으면 `docker start nlt-postgres` 만 하면 된다.

### 3. Redis (권장)

실시간 모션 캐시·프로세스 간 pub/sub용이다. 없어도 서버는 뜨지만, 있으면 좌표 push가 가볍다.

```bash
docker run -d \
  --name nlt-redis \
  -p 6379:6379 \
  redis:7
```

이미 있으면 `docker start nlt-redis`.

### 4. 환경 변수

```bash
cp server/.env.example server/.env
```

로컬 최소 예시:

```env
PORT="3001"
DATABASE_URL="postgresql://nlt:nlt@127.0.0.1:5432/no_last_train?sslmode=disable"
REDIS_URL="redis://127.0.0.1:6379"
# 실시간 WS 포트 (기본 3012). nginx/Vite에서 /ws 로 붙일 때 맞춤
# REALTIME_PORT="3012"
```

`sslmode=disable`을 빼면 안 된다. 런타임은 `@prisma/adapter-pg`로 붙는데, `sslmode`가
없으면 TLS를 시도하고 위 Docker Postgres는 TLS를 받지 않아 API가 이렇게 죽는다.

```text
Error opening a TLS connection: The server does not support SSL connections
```

`prisma db push`(스키마 반영)는 SSL 없이도 붙어서, DB는 멀쩡한데 `/api/health`만
`db: disconnected`로 나오는 모양이 된다. Supabase 등 실제 TLS를 쓰는 DB에서는 대신
`sslmode=no-verify`(또는 `require`)를 쓴다 — 판별 로직은 `server/src/lib/db.ts`에 있다.

선택 항목(AI 명령·메일 등)은 `server/.env.example` 주석을 보면 된다.

프론트 프록시 대상은 `client/.env.example` → `client/.env` (`API_PROXY_TARGET`, 기본 `http://localhost:3001`).

### 5. 프로세스 실행

터미널을 나눠 띄운다. `dev:server` 실행 시 스키마 반영·시드가 자동으로 돌아간다.

```bash
# API (http://localhost:3001)
npm run dev:server

# 실시간 WebSocket (ws://localhost:3012) — 게임 화면 차량 모션에 필요
cd server && npx tsx --env-file-if-exists=.env scripts/realtime-server.ts

# 프론트 (http://localhost:5173)
npm run dev:client
```

로컬 Vite는 `/api` → API(기본 3001), `/ws` → 실시간 서버(기본 3012)로 프록시한다. 포트를 바꿨다면 `client/.env`의 `API_PROXY_TARGET` / `REALTIME_PROXY_TARGET`을 맞춘다.

효과음은 재배포가 제한된 라이선스라 저장소에 두지 않고, 프론트 개발·빌드 시작 시 `scripts/fetch-audio-assets.mjs`가 원본에서 내려받는다(체크섬 검증 포함). 처음 한 번은 네트워크가 필요하고, 이후에는 받아둔 파일을 쓴다.

로컬 디버깅 로그가 필요하면 기존 개발 서버를 끈 뒤:

```bash
npm run dev:logs
```

세션 로그는 `.logs/<시작 시각>/` (`backend.log`, `frontend.log`, `combined.log`, `browser.ndjson`). `.logs/latest.txt`에 최근 세션 이름이 있다. 브라우저 로그 API는 개발 환경에서만 켜지며, 비밀번호·토큰·이메일은 저장 전 마스킹된다. (`dev:logs`는 API·프론트만 띄우므로, 실시간 모션까지 보려면 위 realtime 프로세스를 따로 실행한다.)

## 프로덕션에 가깝게 돌릴 때

이 저장소의 배포 스크립트(`deploy/publish.sh`) 기준이다.

1. PostgreSQL · Redis 기동 (`DATABASE_URL`, `REDIS_URL`을 `server/.env`에 설정)
2. 프론트 빌드 후 nginx 문서 루트로 동기화
3. API: `npm run build:next -w no-last-train-server` 후 PM2 `nlt-server` (`next start`, `NODE_ENV=production`)
4. 실시간: PM2 `nlt-realtime` → `server` cwd에서  
   `node --env-file-if-exists=.env --import tsx scripts/realtime-server.ts`  
   (기본 `REALTIME_PORT=3012`)
5. nginx가 `/api/` → API, `/ws` → realtime 으로 프록시 (`deploy/nginx-nlt-app.inc`)

한 번에 빌드·동기화·재시작:

```bash
./deploy/publish.sh
```

빈 서버에 처음 올리는 절차는 [`deploy/README.md`](deploy/README.md)에 정리했다.
`bootstrap.sh`(패키지·DB·nginx) → `publish.sh`(빌드·배포)까지는 공통이고,
공개 방법만 환경에 따라 갈린다.

- 80/443을 열 수 있는 서버(Oracle Cloud 프리티어 등) → `setup-https.sh` (Let's Encrypt)
- 인바운드를 열 수 없는 머신(외부 IP 없음 등) → `cloudflare-tunnel.sh` (Cloudflare Tunnel)

## 스크립트

| 명령 | 설명 |
|------|------|
| `npm run dev:client` | 프론트 개발 서버 |
| `npm run dev:server` | API 개발 서버 (스키마·시드 포함) |
| `npm run dev:logs` | 프론트·API 실행 및 로컬 로그 수집 |
| `npm run build:client` | 프론트 프로덕션 빌드 |
| `npm run start:client` | 프론트 프로덕션 실행 |
| `npm run build:server` | API 프로덕션 빌드 (`next build`) |
| `npm run start:server` | API 프로덕션 실행 |
| `cd server && npx tsx --env-file-if-exists=.env scripts/realtime-server.ts` | 실시간 WebSocket 서버 |
| `npm run data:demand` | 공공데이터로 승객 수요 프로필 다시 만들기 |
| `npm run data:map` | 공공데이터로 지도 구역·지형 다시 만들기 |

## 승객 수요 — 공공데이터 기반

역에서 사람이 얼마나, 언제 쏟아져 나오는지는 손으로 찍은 숫자가 아니라 **실측 데이터**에서 나온다.
맵(`City.mapKey`)마다 **그 도시의** 지하철 승하차를 쓴다.

| 맵 | 원본 | 범위 |
|----|------|------|
| `SEOUL` | 서울열린데이터광장 [`OA-12921` 서울교통공사_역별 일별 시간대별 승하차인원](https://data.seoul.go.kr/dataList/OA-12921/S/1/datasetView.do) | 1~8호선 271개 역 · 2024년 364일 |
| `BUSAN` | 공공데이터포털 [`3057229` 부산교통공사_시간대별 승하차인원](https://www.data.go.kr/data/3057229/fileData.do) | 1~4호선 112개 역 · 2024년 366일 |

둘 다 **일별** 데이터라 요일을 그대로 셀 수 있다 — 평일/주말 곡선을 통계적 추정 없이 실측으로 가른다.
둘 다 인증키 없이 받을 수 있다.

```bash
npm run data:demand                 # 서울 364일 + 부산 2024년 전체
npm run data:demand -- --year 2025  # 부산은 연 단위 파일이라 연도로 고른다
```

받은 페이지·파일은 `server/.cache/`에 남아 두 번째 실행부터는 네트워크를 타지 않는다.
결과는 `server/src/data/demand-profile.json`과 `client/src/data/demand-profile.json`에
같이 쓰이고(서버 시뮬레이션과 화면 위 시민이 같은 곡선을 봐야 한다) 저장소에 커밋한다.
**게임 실행 중에는 공공데이터 API를 호출하지 않는다.**

### 데이터에서 뽑는 것

| 항목 | 내용 |
|------|------|
| 시간대 곡선 | 평일은 출퇴근 봉우리, 주말은 피크 없이 오후에 평평 |
| 요일 배율 | 월 → 금으로 갈수록 붐비고 토 > 일 — 두 도시 다 실측값 |
| 역 타입별 출발/도착 | 아침엔 주거역이 내보내고 업무역이 받는다. 저녁엔 정확히 반대 |

게임의 역 타입(주거·상업·관광·산업·거점)은 공공데이터에 라벨로 없다. 대신 실제 역의
승하차가 하루 중 언제 몰리는지로 분류해 유형별 평균 곡선을 쓴다. 분류 결과는 프로필
JSON의 `classification`에 남아 눈으로 확인할 수 있다.

- 서울 — 주거 사당·수유·쌍문, 상업 광화문·압구정, 관광 명동·건대입구, 거점 강남·잠실·홍대입구
- 부산 — 주거 동래·부산대·연산, 상업 경성대부경대·범일, 관광 **해운대·광안·남포·다대포해수욕장**, 거점 서면·부산역·사상

(산업형은 두 도시 다 공단역이 적어 실제로는 여의도·시청, 범내골·초량 같은 *평일 전용
업무지구*가 뽑힌다. 평일 출근 집중 + 주말 소멸이라는 곡선 성격은 게임의 산업역과 같다.)

### 두 도시는 실제로 다르게 나온다

같은 파이프라인에 넣었을 뿐인데 부산 곡선은 서울과 뚜렷이 다르다. 전부 2024년 실측 그대로다.

| | 서울 | 부산 |
|---|---|---|
| 주말/평일 총수요 | 0.65 | **0.75** (통근 의존이 낮다) |
| 낮(11~14시) 수요 | 0.8~1.0 | **1.1~1.4** (통근 외 이용이 많다) |
| 저녁 피크 / 낮 | 2.3배 | **1.5배** (완만하다) |
| 20시 이후 | 천천히 식음 | **빨리 식음** (야간 이용이 적다) |

`demand-profile.test.ts`가 이 차이들을 그대로 검증한다 — 두 도시 곡선이 같은 값을 복사한 게
아니라 각자 데이터에서 나왔다는 회귀 방지선이다.

### 어디서 어디로 — 목적지 선택

«얼마나 많이»만으로는 구간이 안 붐빈다. 목적지는 세 가지를 곱해 뽑는다. 셋 다 실측이다.

| 요소 | 근거 |
|------|------|
| 도착역 매력도 | 그 시각 그 타입의 실측 하차량 (위 프로필) |
| **거리 감쇠** `exp(-d/7.6km)` | 서울 지하철 역간 OD 208만 명 적합, R²=0.96 (평균 통행 7.0km) |
| **유형쌍 친화도** | 거리·역 규모를 통제하고 남는 편차. 대체로 1.0이고 거점↔거점만 1.57 |

원본: 공공데이터포털 [`15113638` 서울특별시_지하철 역별 OD](https://www.data.go.kr/data/15113638/fileData.do)
+ [`15099316` 서울교통공사 역사 좌표(위경도)](https://www.data.go.kr/data/15099316/fileData.do).

친화도는 «이중제약 중력모형(IPF)»으로 잰다. `T_ij = A_i·B_j·O_i·D_j·f(d_ij)`를 행·열 합이
실측과 같아질 때까지 조정하면 «역이 크다»와 «가깝다»는 이유가 기대치에 다 흡수되고, 남는
편차만이 유형 때문이다. 이 절차 없이 재면 지리적 군집(주거지는 주거지끼리 붙어 있다)이
유형 선호로 둔갑한다 — 실제로 통제 전 1.17이던 주거↔주거가 통제 후 1.02로 내려간다.

**한계**: 공개된 역간 OD는 **2023-12-31 하루치(일요일)** 뿐이다. 평일 전용 친화도는 잴 수
없어 이 한 벌을 평일에도 쓴다. 거리 감쇠와 시간대별 주변분포는 평일 실측이라 영향은 제한적이고,
친화도 자체가 거점 말고는 거의 1.0이다. 부산은 공개된 역간 OD가 없어 서울 값을 함께 쓴다.

### 승차와 하차

승객은 목적지가 **진행 방향 앞쪽에 있을 때만** 탄다. 목적지 역에 서면 내리고
`arrivedAtTick`이 찍힌다. 그래서 «어느 구간이 붐비는가»가 실제로 관측된다.

환승은 아직 없다(승객 경로 탐색이 없다). 그래서 목적지 후보는 **출발역과 같은 노선에 실린
역**으로 제한한다. 갈 수 없는 곳을 목적지로 주면 승객이 영원히 승강장에 남아 혼잡도만 올린다.

운임은 예전처럼 **승차 기준**이다(경제 밸런스 유지). 도착 수는 `SimResult.totalArrived`로
따로 센다 — 태우기만 하고 못 내려 주면 이 값이 안 오른다.

### 난이도 손잡이

실측 곡선을 그대로 쓰면 게임이 아니라 통계 재생기가 된다. 새벽엔 화면이 비고, 거점역은
평균의 12배까지 튀어 어떤 배차로도 못 버틴다. `server/src/lib/demand-profile.ts`의
`DEMAND_TUNING`이 *모양은 실제, 세기는 조절 가능*하게 만든다.

| 손잡이 | 기본 | 뜻 |
|--------|------|-----|
| `REALISM` | 0.85 | 1이면 실측 곡선 그대로, 0이면 하루 종일 평평 |
| `TYPE_LEVEL_COMPRESSION` | 0.5 | 역 타입 사이 규모 차이를 얼마나 살릴지 (1이면 실제 비율) |
| `NIGHT_FLOOR` | 0.15 | 지하철이 안 다니는 새벽에도 이만큼은 사람이 보이게 |
| `MAX_WEIGHT` | 3.5 | 한 역이 한 시간에 뿜는 승객 상한 (도시 평균 대비) |
| `KM_PER_MAP_UNIT` | 0.3 | 맵 1칸의 실제 거리. 서울역↔강남역 32칸 = 실제 9.6km 기준 |
| `DISTANCE_STRENGTH` | 1 | 거리 감쇠 세기. 0이면 노선 끝과 옆 역이 동등(예전 동작) |
| `AFFINITY_STRENGTH` | 1 | 유형쌍 친화도 세기. 0이면 유형 간 선호 없음 |

손잡이를 어떻게 돌려도 **하루 총수요는 그대로다**(마지막에 평일 평균 1.0으로 재정규화).
정규화는 도시별로 따로 잡으므로, 부산 맵이 서울 맵보다 가난해지지 않는다 — 게임에 들어가는
것은 부산의 절대 승객 수가 아니라 부산의 *곡선 모양*이다.
클라이언트에도 같은 값이 `client/src/demand-profile.ts`에 복사돼 있으니 함께 고쳐야 한다.

## 도시 구역·지형 — 공공데이터 기반

지도 위 «주거·상업·산업 구역»과 산·강·해안선도 손으로 그리지 않는다.
`npm run data:map`이 실측에서 구워 `client/src/data/map-profile.json`에 굳히고,
**게임 실행 중에는 공공데이터 API를 호출하지 않는다.**

| 용도 | 원본 | 비고 |
|------|------|------|
| 역 유형 | 위 승하차 데이터 (서울 `OA-12921` · 부산 `3057229`) | `build-demand-profile.mjs`의 `classifyStations()`를 그대로 태운다 |
| 역 좌표 | OpenStreetMap Overpass `railway=station` | 서울 317 · 부산 99개 |
| 녹지·수역 | OpenStreetMap Overpass `landuse`·`leisure`·`natural` | ODbL |
| 고도 | [AWS Open Data terrain tiles](https://registry.opendata.aws/terrain-tiles/) (SRTM+GMTED) | `elev = R*256 + G + B/256 − 32768` |
| 자치구 이름 | 통계청 센서스용 행정구역경계 2018 ([southkorea-maps](https://github.com/southkorea/southkorea-maps)) | 서울 25 · 부산 16개 |

### 겹치지 않는다 — 잘라 붙이지 않고 격자에 칠하기 때문에

폴리곤을 겹치지 않게 «잘라 붙이는» 대신 **256×256 격자의 각 칸에 유형을 정확히 하나만
배정한 뒤 윤곽을 뽑는다.** 그래서 구역이 겹치는 일이 검사해서 없는 게 아니라 **불가능하다.**
경계는 닿는다.

칸의 유형은 세 신호가 정한다.

| 순위 | 유형 | 신호 |
|---|---|---|
| 1 | 물 | OSM 수역 폴리곤 + SRTM 고도 |
| 2 | 녹지·산 | OSM 공원·산림 폴리곤 **면적** + 그 도시 땅의 상위 18% 고도 |
| 3 | 주거·상업·관광·산업·거점 | 실측 승하차로 분류된 **역**을 거리감쇠 영향장으로 퍼뜨려 유형별 정규화 후 argmax |

세 번째가 요지다. 새 분류기를 만들지 않고 승객 수요와 **같은** 분류를 쓴다 — 강남·잠실이
거점, 사당·수유가 주거, 여의도·시청이 평일 업무지구로 나오는 그 분류다. 구역 이름도 그 안에서
가장 붐비는 역에서 딴다(«강남 거점», «해운대 관광»). 역이 없는 외곽만 자치구 이름으로 떨어진다.

빌드가 굽자마자 65536칸을 다시 세어 **겹친 칸이 0이 아니면 파일을 쓰지 않는다.**
커밋된 데이터에 대해서는 `client/test/map-profile.test.ts`가 같은 검사를 다시 한다.

결과: 서울 36개 · 부산 38개 구역 (예전엔 손으로 그린 12개·7개).

### 왜 토지이용 데이터를 안 쓰나 — 두 가지를 재 보고 버렸다

**OSM `landuse` 폴리곤** — 서울 13,662개를 내려받아 래스터화했더니 맵의 **20%만 덮었고**,
강남역·서울역·잠실·구로디지털단지에 태그가 **아예 없었다**(상업 태그는 전체 태그 면적의 4%).
손으로 그린 것보다 나쁘다.

**OSM POI 밀도 + 위치지수** — 커버리지는 훌륭하다(서울 상업계 122,190 · 주거계 99,680개).
그런데 한국은 주거지 1층이 전부 상가라 **노원역 반경 500m에 상업 POI가 427개**다.
랜드마크 15개 중 6개만 맞았다. 주거와 상업을 가르는 건 POI가 아니라 개찰구 통과량이다.

**법정 용도지역**(국토교통부 용도지역지구도) — 서울은 `data.go.kr` `15082946`에 있으나 파일
내려받기가 열려 있지 않고 **부산은 공개돼 있지 않다.** 두 도시를 같은 방식으로 처리할 수 없다.

### 투영 — 손으로 찍은 역 좌표가 사실상 지리 투영이었다

시드 8개 역의 실제 위경도에 아핀을 맞추면 회전이 거의 0으로 나온다. 실제로 이 지도는
지리적으로 배치돼 있었다.

| | 잔차 RMSE | km/칸 (x, y) |
|---|---|---|
| 서울 | 5.6칸 (1.7km) | 0.30 / 0.34 |
| 부산 | 4.7칸 (2.0km) | 0.52 / 0.34 |

서울 x축 0.30이 `DEMAND_TUNING.KM_PER_MAP_UNIT = 0.3`과 맞아떨어진다. 부산 맵은 가로가
1.5배 늘어나 있어 거리 감쇠를 축별로 잰다.

### 두 도시는 여기서도 다르게 나온다

| | 서울 | 부산 |
|---|---|---|
| 녹지컷 (그 도시 땅 상위 18%) | 100m | **210m** |
| 100m 이상 면적 | 21% | **36%** |
| 최고 고도 | 693m (북한산) | **900m** (금정산 북부) |

고도컷을 «몇 m»로 고정하면 안 된다. 서울에 맞춘 110m를 부산에 그대로 쓰니 부산 땅의 17%가
녹지가 되고 주거가 4%로 쪼그라들었다 — 부산은 비탈에 동네가 앉아 있어서 100~200m가 시가지다.

### 한계

- 구역 유형은 **개찰구 통과량**에서 나온 것이지 법정 용도지역이 아니다. 역에서 멀수록 근거가
  약해지고, 도시 평균의 5%에 못 미치면 주거로 떨어뜨린다.
- 투영 잔차가 1.7~2.0km라 경계에 선 지점은 옆 구역으로 갈 수 있다. 기복이 큰 부산이 특히
  그렇다(부산역이 범일 쪽으로 밀린다).
- `FIT_SCALE` 때문에 서울 서쪽 강서구, 부산 기장군·강서구 일부가 맵 밖으로 잘린다(6.9% / 8.5%).
- 구역은 **장식**이다. 새로 짓는 역은 여전히 항상 주거역이다.
- `KM_PER_MAP_UNIT`은 손대지 않았다. 부산 x축 실측은 0.52라 어긋나지만, 수요·경제 밸런스가
  걸린 값이라 별도로 다룬다. 도시별 실측값은 `source.projection`에 기록해 두었다.

### 손잡이

`server/scripts/build-map-profile.mjs`의 `MAP_TUNING`에 있다.

| 손잡이 | 기본 | 뜻 |
|--------|------|-----|
| `FIT_SCALE` | 서울 0.95 · 부산 0.85 | 역 중심 기준 축소. 낮출수록 덜 잘리고 역은 자기 동네에서 멀어진다 |
| `LAMBDA_KM` | 1.1 | 역 영향 반경. 크면 구역이 뭉개지고 작으면 역마다 조각난다 |
| `ELEV_CUT_Q` | 0.82 | 이 분위수 위는 녹지·산지 (도시별로 다른 m가 나온다) |
| `FIELD_FLOOR` | 0.05 | 역이 이만큼도 안 닿는 곳은 근거 없음 → 주거 |
| `MIN_BLOB` | 0.0015 | 이보다 작은 덩어리는 이웃에 흡수 → **구역 개수를 정하는 손잡이** |
| `GRID` | 256 | 분류 격자이자 랜드마스크 해상도 (1칸 ≈ 117m) |
| `SNAP` · `SHAPE_EPS` | 0.1 · 0.4 | 정점 격자와 윤곽 단순화. 키우면 번들이 가벼워지고 해안선이 뭉툭해진다 |
| `CONTOUR_M` · `RELIEF_M` | 100·200·400·800 / 100·300 | 등고선과 고도대 경계 |

`isLand`(시민이 걸을 수 있는 땅)는 이제 폴리곤이 아니라 **256×256 비트마스크 조회**다.
정수 연산 여섯 번이라 매 프레임 도는 경로 검사가 예전 ray-cast보다 훨씬 싸고,
여의도 같은 하드코딩 예외도 사라졌다.


## 화면

- **타이틀** - 시작 / 설정
- **로비** - 관제실 선택
