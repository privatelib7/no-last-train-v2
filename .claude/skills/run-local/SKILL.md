---
name: run-local
description: 이 저장소(막차는 없다 / no-last-train)를 로컬에서 띄우고 확인하는 절차. 사용자가 "로컬에서 띄워줘", "실행해줘", "돌려보고 확인해줘", "서버 켜줘", "게임 화면 보여줘", "DB 붙여줘"처럼 이 프로젝트를 실제로 구동하길 원하면 반드시 이 스킬을 먼저 읽는다. 시뮬레이션·수요 프로필·API 변경을 실제 앱에서 확인해야 할 때도 쓴다. 컨테이너(colima/Postgres/Redis) 기동, .env의 sslmode 함정, 3개 프로세스 실행 순서, 로그인 벽을 우회하는 헤드리스 검증 방법까지 담고 있다.
---

# 로컬 실행

이 앱은 프로세스 하나가 아니다. **Postgres + (선택)Redis + API + 실시간 WebSocket + 프론트**가
같이 떠야 화면에 차량이 움직인다. 순서대로 올리고, 각 단계에서 «떴다»를 눈으로 확인한 뒤 다음으로 간다.
확인 없이 다음 단계로 가면 마지막에 빈 화면만 보고 원인을 거슬러 올라가게 된다.

## 1. 컨테이너 런타임

이 머신은 Docker Desktop이 아니라 **colima**를 쓴다.

```bash
docker ps >/dev/null 2>&1 || colima start --cpu 2 --memory 4
```

`colima start`는 리눅스 VM을 띄우므로 30~60초 걸린다. 백그라운드로 돌리고 기다린다.
**주의**: colima가 뜨면 사용자의 다른 프로젝트 컨테이너도 같이 올라온다. 그것들은 건드리지 않는다.

## 2. Postgres · Redis

컨테이너가 이미 있을 가능성이 높다. `docker run`부터 하면 이름 충돌로 실패한다 —
있으면 `start`, 없으면 `run`.

```bash
docker start nlt-postgres 2>/dev/null || docker run -d --name nlt-postgres \
  -e POSTGRES_USER=nlt -e POSTGRES_PASSWORD=nlt -e POSTGRES_DB=no_last_train \
  -p 5432:5432 postgres:16

docker start nlt-redis 2>/dev/null || docker run -d --name nlt-redis -p 6379:6379 redis:7
```

Redis는 선택이다. 없으면 실시간 모션이 DB 직접 조회로 폴백할 뿐 동작은 한다.

포트가 이미 물려 있으면(`bind: address already in use`) 다른 프로젝트 컨테이너를 죽이지 말고,
그 컨테이너가 뭔지 확인해서 사용자에게 알린다: `docker ps --format "{{.Names}}|{{.Ports}}"`.

## 3. 환경 변수

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env
```

`server/.env`의 `DATABASE_URL`에 **`?sslmode=disable`이 반드시 있어야 한다.**

```env
DATABASE_URL="postgresql://nlt:nlt@127.0.0.1:5432/no_last_train?sslmode=disable"
```

런타임은 `@prisma/adapter-pg`(node-postgres)로 붙는데, `sslmode`가 없으면 TLS를 시도하고
로컬 Docker Postgres는 TLS를 받지 않는다. 이 실패는 **엉뚱하게 보인다** — `prisma db push`는
SSL 없이도 붙어서 스키마 반영·시드가 멀쩡히 끝나고, 그 다음에야 API만 이렇게 죽는다.

```text
Error opening a TLS connection: The server does not support SSL connections
```

`.env.example`에는 이미 들어 있으니 그대로 복사하면 된다. 값을 직접 쓸 때만 조심한다.

## 4. 프로세스 3개

셋 다 포그라운드로 계속 도는 프로세스다. 백그라운드로 띄우고 로그를 파일로 받는다.

```bash
# API (3001) — 실행 시 prisma generate → db push → seed가 먼저 돈다
npm run dev:server > /tmp/nlt-api.log 2>&1 &

# 실시간 WebSocket (3012) — 차량 모션에 필요. 없으면 화면에서 차량이 멈춰 있다
(cd server && npx tsx --env-file-if-exists=.env scripts/realtime-server.ts) > /tmp/nlt-realtime.log 2>&1 &

# 프론트 (5173)
npm run dev:client > /tmp/nlt-client.log 2>&1 &
```

프론트는 브라우저 패널로 볼 거라면 `.claude/launch.json`의 `client` 설정으로
`preview_start`를 쓰는 편이 낫다(이미 저장소에 있다).

### 떴는지 확인

`sleep`으로 짐작하지 말고 조건이 참이 될 때까지 기다린다.

```bash
until curl -s --max-time 5 http://localhost:3001/api/health | grep -q '"status"'; do sleep 1; done
curl -s http://localhost:3001/api/health   # {"status":"ok","db":"connected"}
grep "listening on :3012" /tmp/nlt-realtime.log
```

`db":"disconnected"`가 나오면 3번의 `sslmode`를 먼저 의심한다.

## 5. 화면 확인 — 로그인 벽

`/api/cities`(목록)는 공개지만 **`/api/cities/{id}`는 401**이다. 도시에 들어가려면 로그인해야 한다.

에이전트는 계정을 만들거나 비밀번호를 입력하지 않는다. 화면 확인이 필요하면 브라우저를
로그인 화면까지 띄워 두고 **사용자에게 로그인을 요청한다.** 그 전에는 UI를 클릭해 봐야 진도가 안 나간다.

로그인 없이 폴링해 봐야 401이라 틱이 전혀 안 도는데, 화면상 기존 승객 수는 그대로라서
«돌아가고 있다»로 착각하기 쉽다. 응답 코드를 반드시 확인한다.

## 6. 헤드리스 검증 — 로그인 없이 시뮬레이션 돌리기

시뮬레이션·수요·경제 쪽 변경은 UI 없이 서버에서 바로 확인하는 게 빠르고 정확하다.
`scripts/verify-demand.ts`가 그 방법을 담고 있다: **임시 도시를 만들어 하루치(144틱)를
실제 DB로 돌리고, 생성된 승객을 시간대·역타입별로 세어 기대 곡선과 비교한 뒤 지운다.**

```bash
cd server && npx tsx --env-file-if-exists=.env ../.claude/skills/run-local/scripts/verify-demand.ts
```

사용자의 기존 도시는 건드리지 않는다. 다른 것을 재려면 이 스크립트를 복사해서
집계 부분만 바꾸는 게 빠르다 — 도시 생성·정리 골격은 그대로 쓸 수 있다.

시뮬레이션을 직접 부를 때 알아둘 것:
- `simulateTicks(cityId, n)`는 도시 단위 DB 어드바이저리 락을 잡는다. 같은 도시를 동시에 돌리지 않는다.
- 승객이 안 타고 쌓이면 `rate *= max(0.4, 1 - congestion*0.55)` 감쇠가 걸려 곡선이 왜곡된다.
  순수 생성량을 재려면 역 `capacity`를 크게 준다.
- tsx는 CJS로 변환해서 톱레벨 `await`이 안 된다. `async function main()`으로 감싼다.

## 7. 정리

컨테이너는 사용자의 다른 작업과 얽혀 있으니 **자동으로 지우지 않는다.** 프로세스만 내린다.

```bash
# 백그라운드 작업 종료 (TaskStop 또는)
pkill -f "next dev" ; pkill -f "realtime-server" ; pkill -f "vite"
```

`docker stop nlt-postgres nlt-redis`나 `colima stop`은 사용자가 요청할 때만 한다.

## 자주 겪는 증상

| 증상 | 원인 |
|------|------|
| `/api/health`가 `db: disconnected` | `DATABASE_URL`에 `?sslmode=disable` 없음 (3번) |
| `docker: ... name is already in use` | 컨테이너가 이미 있음 — `run` 말고 `start` (2번) |
| 화면은 뜨는데 차량이 안 움직임 | 실시간 서버(3012) 안 뜸 (4번) |
| 도시 클릭하면 아무 일도 안 남 | 401 — 로그인 필요 (5번) |
| `Top-level await is currently not supported` | tsx 스크립트를 `async function main()`으로 감싸기 (6번) |
| colima 뜬 뒤 모르는 컨테이너가 보임 | 사용자의 다른 프로젝트 것. 두고 본다 (1번) |
