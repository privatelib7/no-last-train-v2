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
3. API: `npm run build:next -w no-last-train-server` 후 PM2 `nlt-server`
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
| `npm run build:server` | 백엔드 프로덕션 빌드 (Cloudflare 경로) |
| `npm run start:server` | API 프로덕션 실행 |
| `cd server && npx tsx --env-file-if-exists=.env scripts/realtime-server.ts` | 실시간 WebSocket 서버 |
| `npm run data:demand` | 공공데이터로 승객 수요 프로필 다시 만들기 |

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

## 화면

- **타이틀** - 시작 / 설정
- **로비** - 관제실 선택
