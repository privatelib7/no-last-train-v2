# 배포

인스턴스 하나에 전부(정적 프론트 · API · 실시간 WS · PostgreSQL · Redis) 올리고,
nginx 가 한 오리진에서 라우팅한다.

```text
            https://<도메인>
                   │
          nginx (80/443 또는 8080)
        ┌──────────┼─────────────────┐
   /              /api/              /ws
 정적 파일     127.0.0.1:3001    127.0.0.1:3012
 /var/www/nlt  PM2 nlt-server    PM2 nlt-realtime
                   └──────┬───────────┘
                  PostgreSQL 16 · Redis 7 (docker, 127.0.0.1 전용)
```

경로는 두 가지다. 서버 준비(`bootstrap.sh`)와 배포(`publish.sh`)는 공통이고,
공개하는 방법만 다르다.

| | A. 공인 IP 서버 | B. 인바운드 불가 머신 |
|---|---|---|
| 예 | Oracle Cloud 프리티어, 일반 VPS | 외부 IP 없는 사내 VM, 방화벽 권한 없는 환경 |
| 공개 방법 | 80/443 직접 개방 + Let's Encrypt | **Cloudflare Tunnel** (아웃바운드만 사용) |
| 마지막 단계 | `setup-https.sh` | `cloudflare-tunnel.sh` |
| 문서 | [공인 IP 서버에 배포](#공인-ip-서버에-배포-oracle-cloud-프리티어) | [터널로 공개하기](#터널로-공개하기-cloudflare-tunnel) |

---

## 터널로 공개하기 (Cloudflare Tunnel)

외부 IP 가 없거나 방화벽 규칙을 만들 권한이 없는 머신에서 쓴다. `cloudflared` 가
Cloudflare 로 **아웃바운드** 연결만 맺고, 그 위로 트래픽이 들어온다. 인바운드 포트를
하나도 열지 않으므로 같은 머신의 다른 서비스는 노출되지 않는다.

전제: 공개할 도메인이 **Cloudflare zone** 이어야 한다(네임서버가 Cloudflare 로
이전된 상태). 도메인·계정을 가진 사람이 2번 절을 직접 수행해야 한다.

### 1. 서버 준비 · 배포 (계정 없이 가능)

```bash
git clone <저장소 URL> ~/no-last-train && cd ~/no-last-train
./deploy/bootstrap.sh --http-port 8080 --skip-firewall
./deploy/publish.sh --seed
```

- `--http-port 8080` : nginx 를 8080 에 띄운다(터널이 바라보는 포트). 80 을 건드리지 않는다.
- `--skip-firewall` : iptables·certbot 을 건너뛴다. TLS 는 Cloudflare 가 종단한다.
- `--seed` 는 최초 1회만. 시연용 도시 데이터를 만들면서 기존 데이터를 지운다.

여기까지면 `http://127.0.0.1:8080` 에서 게임이 돈다. 확인:

```bash
curl -s http://127.0.0.1:8080/api/health   # {"status":"ok","db":"connected"}
```

### 2-a. Cloudflare 인증 — 계정 소유자가 서버에서 직접 수행할 때

```bash
cloudflared tunnel login
```

출력된 `https://dash.cloudflare.com/argotunnel?...` URL 을 브라우저에서 열고,
대상 도메인(zone)을 선택해 **Authorize** 한다. 성공하면 서버의
`~/.cloudflared/cert.pem` 이 생긴다. 이 인증서는 터널 생성·DNS 등록 권한만 갖는다.

`cloudflared` 가 없으면 Cloudflare 공식 저장소에서 설치한다.

```bash
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared
```

### 2-b. 계정 소유자가 서버에 접근할 수 없을 때 (대시보드 + 토큰)

도메인·계정을 가진 사람과 서버를 만지는 사람이 다르면, 위의 `cloudflared tunnel login`
대신 대시보드에서 터널을 만들고 **토큰만** 건네받는다. 서버 주소나 SSH 접근을 넘길
필요가 없다.

**계정 소유자가 할 일** (Cloudflare 대시보드)

1. **Zero Trust → Networks → Tunnels → Create a tunnel** → **Cloudflared** 선택 →
   이름 `nlt`
2. 다음 화면의 설치 명령에 들어 있는 **토큰**(`eyJ…` 로 시작하는 긴 문자열)을
   서버 담당자에게 전달한다. 비밀값이므로 안전한 경로로 보내고, 유출되면
   대시보드에서 터널을 삭제·재생성하면 무효화된다.
3. **Public Hostname** 탭 → **Add a public hostname**
   - Subdomain: 비움(루트로 쓸 때) 또는 `game`
   - Domain: `nolasttrain.live`
   - Type: **HTTP**, URL: **`localhost:8080`**
4. 저장. DNS CNAME 은 Cloudflare 가 자동으로 만든다.

주의: 이 호스트명에 **Access(인증) 정책을 걸지 않는다**. 걸면 게임 접속 전에
Cloudflare 로그인을 요구한다. WebSocket(`/ws`)은 기본으로 통과하므로 따로 켤 것은 없다.

**서버 담당자가 할 일** — 받은 토큰으로 한 줄이면 끝이다. 설정(ingress·DNS)은
대시보드에 있으므로 `cloudflare-tunnel.sh` 도, `cert.pem` 도 필요 없다.

```bash
sudo cloudflared service install <토큰>
systemctl status cloudflared
```

### 3. 터널 연결 (2-a 로 인증했을 때)

```bash
./deploy/cloudflare-tunnel.sh nolasttrain.live --port 8080
```

스크립트가 하는 일: 터널 생성(`nlt`) → `~/.cloudflared/config.yml` 작성
(ingress: 호스트명 → `http://localhost:8080`) → **DNS CNAME 자동 등록** →
systemd 서비스로 상시 실행.

`APP_BASE_URL` 도 맞춰 준다.

```bash
sed -i 's|^APP_BASE_URL=.*|APP_BASE_URL="https://nolasttrain.live"|' server/.env
pm2 reload nlt-server --update-env
```

### 4. 확인

```bash
curl -s https://nolasttrain.live/api/health
curl -s -o /dev/null -w '%{http_code}\n' https://nolasttrain.live/
```

WebSocket 은 `wss://<도메인>/ws` 로 붙는다. cloudflared 는 별도 설정 없이 통과시킨다.

### 도메인 없이 임시 주소로 먼저 띄우기

Cloudflare 계정도 도메인도 없이 즉시 확인할 때 쓴다. 재시작하면 주소가 바뀌므로
공유용으로는 부적합하다.

```bash
pm2 start "$(command -v cloudflared)" --name nlt-tunnel -- tunnel --url http://localhost:8080
pm2 logs nlt-tunnel --nostream | grep trycloudflare   # 발급된 주소 확인
```

내릴 때는 `pm2 stop nlt-tunnel`, 고정 도메인으로 갈아탄 뒤에는 `pm2 delete nlt-tunnel`.

## 공인 IP 서버에 배포 (Oracle Cloud 프리티어)

80/443 을 인터넷에 직접 열 수 있는 서버용이다. Oracle 프리티어 기준으로 적었지만,
3절부터는 어떤 VPS 든 같다.

### 1. 계정 · Always Free 한도

- <https://www.oracle.com/kr/cloud/free/> 에서 가입한다. 신용/체크카드 본인 확인이
  필요하고 소액(약 1달러)이 임시 승인됐다 취소된다.
- **홈 리전은 가입 후 바꿀 수 없다.** 한국이면 `South Korea Central (Seoul)` 또는
  `South Korea North (Chuncheon)` 를 고른다.
- Always Free 로 쓸 수 있는 컴퓨트 ([공식 문서](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm)):
  - **Ampere A1 (Arm, `VM.Standard.A1.Flex`)** — 월 1,500 OCPU 시간 + 9,000 GB 시간.
    24시간 켜두는 기준으로 **2 OCPU / 12 GB** 다(원하는 대로 쪼개 쓸 수 있다). ← 권장
  - AMD **`VM.Standard.E2.1.Micro`** — 1/8 OCPU / 1 GB RAM, 2대
  - 부트 볼륨 · 블록 볼륨 합계 200 GB 까지 무료. 기본 부트 볼륨은 50 GB 다.
- 계정에 따라 A1 한도가 4 OCPU / 24 GB 로 잡혀 있기도 하다. 인스턴스 생성 화면에서
  shape 옆에 **"항상 무료 적격"(Always Free-eligible)** 배지가 붙는지 보면 된다.
- 가입 직후 계정이 "Upgrade and Pay As You Go" 로 보여도, Always Free 리소스만
  쓰면 과금되지 않는다.

> **놀고 있는 인스턴스는 회수될 수 있다.** Always Free 계정에서 7일 동안
> CPU(95 백분위)·네트워크·메모리 사용률이 모두 20% 미만이면 Oracle 이 인스턴스를
> 회수할 수 있다([문서](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)).
> 접속자가 적은 게임 서버는 여기 걸리기 쉽다. 확실히 막으려면 **Pay As You Go 로
> 업그레이드**한다 — 업그레이드해도 Always Free 한도 안의 리소스는 계속 무료이고,
> 회수 대상에서 빠진다. 그대로 쓴다면 아래 백업을 챙겨 두는 편이 좋다.

### 2. 고정 공인 IP 예약

인스턴스를 지웠다 다시 만들어도 주소가 유지되도록 먼저 예약해 둔다.

1. 콘솔 좌측 메뉴 → **네트워킹 → IP 관리 → 예약된 공용 IP** (Reserved public IPs)
2. **공용 IP 주소 예약** → 이름 입력 → 생성
3. 만들어진 IP 를 적어 둔다. 예: `152.70.100.20`

> 건너뛰고 인스턴스의 임시(ephemeral) IP 를 그대로 써도 된다. 다만 인스턴스를
> 재생성하면 주소가 바뀐다.

### 3. 인스턴스 생성

**컴퓨트 → 인스턴스 → 인스턴스 생성**

| 항목 | 값 |
|------|-----|
| 이름 | `nlt` (아무거나) |
| 이미지 | **Canonical Ubuntu 24.04** (22.04 도 됨) |
| Shape | **VM.Standard.A1.Flex** — OCPU 2, 메모리 12 GB (한도가 4/24 면 그대로 써도 된다) |
| 네트워킹 | 새 VCN·서브넷 자동 생성, **공용 IPv4 주소 할당: 예** |
| SSH 키 | **키 쌍 생성 후 개인 키 저장** (`nlt.key`) — 다시 못 받는다 |
| 부트 볼륨 | 50 GB (기본 46.6 GB 그대로 둬도 됨) |

- A1 이 **"Out of capacity"** 로 실패하면: 다른 가용성 도메인(AD-1/2/3)으로 바꿔
  재시도하거나, OCPU 를 1 로 줄여 시도한다. 그래도 안 되면 잠시 뒤 다시 시도하거나
  `VM.Standard.E2.1.Micro`(x86, 1 GB) 로 시작한다. 이 배포는 Micro 에서도 동작하지만
  빌드가 느리고 메모리가 빠듯하다(bootstrap 이 스왑 2 GB 를 자동으로 만든다).
- 개인 키 권한: `chmod 400 nlt.key`

#### 예약 IP 연결 (2번을 했다면)

인스턴스 상세 → **리소스 → 연결된 VNIC → VNIC 이름 → IPv4 주소 → 편집**
→ 기존 공용 IP 를 **없음**으로 바꿔 저장 → 다시 편집 → **예약된 IP 선택** → 저장.

### 4. 방화벽: 보안 목록에 80 · 443 열기

Oracle 은 **클라우드 방화벽(보안 목록)** 과 **인스턴스 안 iptables** 두 겹이다.
아래는 클라우드 쪽이고, 인스턴스 쪽은 `bootstrap.sh` 가 처리한다.

**네트워킹 → 가상 클라우드 네트워크 → (VCN) → 보안 목록 → 기본 보안 목록 →
수신 규칙 추가**

| 소스 CIDR | IP 프로토콜 | 대상 포트 |
|-----------|-------------|-----------|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

포트마다 규칙을 따로 만든다. (5432·6379 는 절대 열지 않는다 — DB 는 로컬 전용이다.)

### 5. 접속

```bash
ssh -i nlt.key ubuntu@<공인 IP>
```

### 6. 저장소 클론 · 셋업

```bash
sudo apt-get update && sudo apt-get install -y git
git clone <이 저장소 URL> ~/no-last-train
cd ~/no-last-train
./deploy/bootstrap.sh
```

`bootstrap.sh` 가 하는 일:

1. Node 22 · PM2 · nginx · Docker · certbot 설치
2. `nlt-postgres`(PostgreSQL 16) · `nlt-redis`(Redis 7) 컨테이너 기동 —
   **127.0.0.1 에만 바인딩**하므로 외부에서 접근할 수 없다
3. `server/.env` 생성 (DB 비밀번호 자동 생성)
4. iptables 80/443 개방 + 영구 저장
5. nginx 사이트 설치

#### 도메인 고르기

인자가 없으면 공인 IP 기반 **sslip.io** 주소를 자동으로 쓴다
(`152.70.100.20` → `152-70-100-20.sslip.io`). 가입도 DNS 설정도 필요 없어 바로
접속되지만, sslip.io 는 Public Suffix List 에 없어 **Let's Encrypt 발급량을
sslip.io 도메인 전체가 공유한다** — 인증서 발급이 rate limit 에 막힐 수 있다.

| 선택 | 준비 | HTTPS |
|------|------|-------|
| `<ip>.sslip.io` (기본) | 없음 | 될 때도, rate limit 에 막힐 때도 있다 |
| `<이름>.duckdns.org` | <https://www.duckdns.org> 무료 로그인 → 서브도메인 만들고 공인 IP 등록 | **안정적** (PSL 등재라 발급량이 독립) |
| 보유 도메인 | A 레코드를 공인 IP 로 지정 | 안정적 |

HTTPS 를 쓸 생각이면 DuckDNS 나 보유 도메인을 권한다.

```bash
./deploy/bootstrap.sh --domain no-last-train.duckdns.org
```

나중에 도메인을 바꿔도 같은 명령을 다시 실행하면 nginx 설정이 갱신된다
(이미 certbot 설정이 들어간 뒤라면 `--force-nginx` 를 붙인다).

#### 선택 환경변수

AI 명령 해석·회원가입 인증 메일을 쓰려면 `server/.env` 에 채운다
(항목 설명은 `server/.env.example`).

```bash
nano ~/no-last-train/server/.env
```

| 키 | 없으면 |
|----|--------|
| `OPENAI_API_KEY` | AI 운영관 명령 해석 비활성 |
| `ANTHROPIC_API_KEY` | 노선 정책 자연어 파싱 비활성 |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | 이메일 인증 메일 발송 불가 |

### 7. 빌드 · 배포

```bash
./deploy/publish.sh --seed
```

- 최초 1회만 `--seed` 를 붙인다 (시연용 도시 데이터 생성). 이후 재배포에는 붙이지
  않는다 — 시드는 시연 도시를 다시 만들면서 기존 데이터를 지운다.
- 끝나면 API·실시간·nginx 헬스 체크를 돌리고 접속 주소를 출력한다.
- 이 시점에 `http://<도메인>` 으로 게임이 열린다.

### 8. HTTPS

```bash
./deploy/setup-https.sh
# 또는: ./deploy/setup-https.sh game.example.com you@example.com
```

certbot 이 인증서를 발급하고 nginx 에 443 블록 + http→https 리다이렉트를 넣는다.
`APP_BASE_URL` 도 https 로 갱신된다. 갱신은 `certbot.timer` 가 자동으로 한다.

sslip.io 주소에서 `too many certificates already issued` 가 나오면 rate limit 이다.
DuckDNS 서브도메인을 만들어 `./deploy/bootstrap.sh --domain <이름>.duckdns.org` 로
갈아탄 뒤 다시 실행하면 된다.

브라우저에서 `https://<도메인>` 으로 접속하면 끝이다. WebSocket 도 같은 오리진의
`wss://<도메인>/ws` 로 자동으로 붙는다.

---

## 램이 적은 서버 (E2.1.Micro 등 1 GB)

`bootstrap.sh` 가 메모리 4 GB 미만이면 스왑 2 GB 를 자동으로 만든다. 그래도 빌드가
OOM 으로 죽으면, **같은 아키텍처·같은 Node 메이저 버전**의 다른 머신에서 빌드해
산출물만 보내고 인스턴스에서는 실행만 시킨다.

```bash
# 빌드 머신에서
npm ci
npm run build:next -w no-last-train-server
npm run build:client

# 산출물 전송 (x86_64 → x86_64, ARM → ARM 이어야 한다. prisma·swc 바이너리가 아키텍처별이다)
rsync -az --delete node_modules/    ubuntu@<IP>:~/no-last-train/node_modules/
rsync -az --delete server/.next/    ubuntu@<IP>:~/no-last-train/server/.next/
rsync -az --delete client/dist/     ubuntu@<IP>:~/no-last-train/client/dist/

# 인스턴스에서 — 설치·빌드를 건너뛰고 배포만
./deploy/publish.sh --skip-install --skip-build --seed
```

실행 자체도 빠듯하다. 측정 기준 `nlt-server` 약 260 MB, `nlt-realtime` 약 145 MB,
PostgreSQL 약 80 MB 라 1 GB 에서는 스왑에 기대게 된다. 여유가 필요하면 Redis 를
빼도 된다(없으면 PostgreSQL 직접 조회로 폴백한다).

## 운영

```bash
pm2 status                       # 프로세스 상태
pm2 logs nlt-server --lines 100  # API 로그
pm2 logs nlt-realtime            # 실시간 서버 로그
pm2 restart nlt-server

cd ~/no-last-train && ./deploy/publish.sh --pull   # 최신 코드로 손수 재배포

sudo docker ps                                     # DB · Redis 상태
sudo docker exec -it nlt-postgres psql -U nlt no_last_train
```

### 백업

```bash
sudo docker exec nlt-postgres pg_dump -U nlt no_last_train | gzip > ~/nlt-$(date +%F).sql.gz
```

되돌릴 때:

```bash
gunzip -c ~/nlt-2026-08-19.sql.gz | sudo docker exec -i nlt-postgres psql -U nlt no_last_train
```

## 자동 배포 (main 에 머지되면 배포)

프로덕션 체크아웃이 `origin/main` 을 주기적으로 확인해, 새 커밋이 있으면
`publish.sh` 를 돌린다. systemd 타이머 하나가 전부라 인바운드 포트도, 저장소
시크릿도, 러너도 필요 없다.

> GitHub Actions 에서 서버로 미는 방식(셀프호스티드 러너 · 웹훅)은 저장소
> **관리자** 권한이 있어야 한다. 권한이 없거나 인바운드가 막힌 머신에서는
> 이 폴링 방식을 쓴다.

### 1. 배포 전용 체크아웃

자동 배포는 `git reset --hard origin/main` 으로 코드를 맞춘다. 개발용 체크아웃에서
돌리면 작업 중인 변경이 날아가므로 배포 전용 워크트리를 따로 둔다.

```bash
git -C ~/no-last-train worktree add --detach ~/nlt-prod origin/main
cp ~/no-last-train/server/.env        ~/nlt-prod/server/.env
cp ~/no-last-train/deploy/.env.deploy ~/nlt-prod/deploy/.env.deploy
cd ~/nlt-prod && ./deploy/publish.sh          # PM2 를 새 경로로 옮긴다
```

`ecosystem.config.cjs` 는 경로를 `__dirname` 기준으로 잡으므로, 새 체크아웃에서
`publish.sh` 를 한 번 돌리면 PM2 가 그쪽을 바라본다. `pm2 save` 까지 스크립트가 한다.

### 2. 타이머 설치

```bash
cd ~/nlt-prod
./deploy/install-auto-deploy.sh                  # 1 분마다 확인
./deploy/install-auto-deploy.sh --interval 5min  # 간격 변경
```

`/etc/systemd/system/nlt-auto-deploy.{service,timer}` 를 만들고 타이머를 켠다.
간격을 바꿀 때는 유닛 파일을 직접 고치지 말고 `--interval` 로 다시 실행한다.

### 동작

1. `git fetch origin main`
2. `HEAD` 와 `FETCH_HEAD` 가 같으면 아무것도 하지 않고 끝난다 (로그도 남기지 않는다)
3. 다르면 `git reset --hard` 후 `publish.sh` — 설치 · 빌드 · 정적 동기화 · PM2 reload · 헬스 체크
4. 헬스 체크가 실패하면 유닛이 `failed` 로 남는다

타이머는 앞 회차가 **끝난 뒤**부터 간격을 세고 스크립트도 `flock` 으로 잠그므로
배포끼리 겹치지 않는다. 한 번 배포에 보통 2~3 분 걸린다.

`git fetch` 는 `gh auth git-credential` 로 인증한다. 토큰이 풀리면 배포가 멈추므로
`journalctl` 에 fetch 실패가 보이면 `gh auth status` 를 확인한다.

### 확인 · 조작

```bash
journalctl -u nlt-auto-deploy -f                    # 배포 로그
systemctl list-timers nlt-auto-deploy.timer         # 다음 실행 시각
sudo systemctl start nlt-auto-deploy.service        # 기다리지 않고 지금 배포
sudo systemctl stop  nlt-auto-deploy.timer          # 잠시 멈춤 (재부팅하면 다시 켜진다)
./deploy/install-auto-deploy.sh --uninstall         # 완전히 제거

cd ~/nlt-prod && ./deploy/auto-deploy.sh --force    # 커밋이 같아도 다시 배포
```

### 되돌리기

`main` 을 되돌리면 다음 회차가 그 커밋으로 맞춘다. 이게 정공법이다.
급할 때 서버에서 먼저 되돌리려면:

```bash
sudo systemctl stop nlt-auto-deploy.timer
cd ~/nlt-prod && git reset --hard <되돌릴-커밋> && ./deploy/publish.sh
```

타이머를 멈추지 않으면 다음 폴링이 다시 `origin/main` 으로 끌고 간다.
`main` 을 고친 뒤 타이머를 다시 켠다.

---

## 문제 해결

| 증상 | 확인 |
|------|------|
| 브라우저에서 아예 안 열림 | 보안 목록 수신 규칙(80/443) → `sudo iptables -L INPUT -n --line-numbers` 에 ACCEPT 가 REJECT 보다 위에 있는지 |
| 502 Bad Gateway | `pm2 status`, `pm2 logs nlt-server` — Next 가 죽었거나 포트 불일치 |
| 화면은 뜨는데 차량이 안 움직임 | `pm2 logs nlt-realtime`, `curl -sv http://127.0.0.1:3012/health`, 브라우저 콘솔에서 `/ws` 연결 확인 |
| `server does not support SSL connections` | `server/.env` 의 `DATABASE_URL` 끝에 `?sslmode=disable` 이 있는지 (로컬 Docker PostgreSQL 은 TLS 를 안 쓴다) |
| certbot 실패 | 80 이 인터넷에서 열려 있는지, 도메인이 이 인스턴스 IP 로 해석되는지 (`dig +short <도메인>`) |
| `"next start" does not work with "output: standalone"` 경고 | 무시해도 된다. 이 저장소는 API 전용이라 `next start` 로 정상 동작한다(검증됨) |
| 빌드 중 OOM (Micro 인스턴스) | 스왑 확인 `free -h`, `pm2 stop all` 후 빌드 재시도 |
| 터널은 붙었는데 502 | `curl http://127.0.0.1:8080/` 로 nginx 부터 확인, 그다음 `pm2 status` |
| `cloudflared tunnel login` 이 만료됨 | 대기 시간이 지나면 종료된다. 브라우저 앞에 있을 때 다시 실행한다 |
| `route dns` 가 실패 | 그 도메인이 Cloudflare zone 이 아니거나, 같은 이름의 레코드가 이미 있다 |
| A1 생성이 계속 실패 | 용량은 수시로 바뀐다. 간격을 늘려(`--retry-interval 300` 이상) 길게 돌리거나, OCPU 를 줄이거나(`--ocpus 1 --memory 6`), `VM.Standard.E2.1.Micro` 로 시작한다 |
| `TooManyRequests`(429) | 생성 요청이 잦았다. 스크립트가 `--throttle-wait` 만큼 쉬고 이어간다 |
| main 에 머지했는데 배포가 안 됨 | `systemctl list-timers nlt-auto-deploy.timer` 로 타이머가 켜져 있는지, `journalctl -u nlt-auto-deploy -n 50` 으로 fetch·빌드 실패가 있는지 |
| 자동 배포가 `git fetch` 에서 실패 | `gh auth status` — `gh auth git-credential` 토큰이 풀렸다. `gh auth login` 후 `sudo systemctl start nlt-auto-deploy.service` |
| 배포는 됐는데 옛 코드가 보임 | 브라우저 캐시가 아니라면 `cd ~/nlt-prod && git log --oneline -1` 로 실제 배포된 커밋을 확인한다 |

## 부록: OCI CLI 로 인스턴스 만들기

콘솔에서 클릭하는 대신 `deploy/oci-create-instance.sh` 로 VCN·보안 규칙·인스턴스를
한 번에 만들 수 있다. **A1 이 "Out of capacity" 로 막힐 때 가용성 도메인을 돌아가며
자동 재시도**하는 게 가장 큰 이점이다.

### 1. CLI 설치

```bash
python3 -m venv ~/.oci-cli-venv && ~/.oci-cli-venv/bin/pip install -q oci-cli
export PATH="$HOME/.oci-cli-venv/bin:$PATH"
```

### 2. API 키 등록

1. 콘솔 우측 상단 프로필 아이콘 → **내 프로필**
2. 왼쪽 **리소스 → API 키** → **API 키 추가**
3. **API 키 쌍 생성** 선택 → **개인 키 다운로드** (`~/.oci/oci_api_key.pem` 으로 저장)
4. **추가** 를 누르면 나오는 **구성 파일 미리보기** 내용을 그대로 복사

```bash
mkdir -p ~/.oci && chmod 700 ~/.oci
nano ~/.oci/config          # 복사한 내용 붙여넣기
# key_file= 줄을 실제 개인 키 경로로 고친다
chmod 600 ~/.oci/config ~/.oci/oci_api_key.pem
```

`~/.oci/config` 는 이런 모양이다(개인 키 자체는 별도 파일이다).

```ini
[DEFAULT]
user=ocid1.user.oc1..aaaa...
fingerprint=ab:cd:...
tenancy=ocid1.tenancy.oc1..aaaa...
region=ap-seoul-1
key_file=~/.oci/oci_api_key.pem
```

동작 확인:

```bash
oci iam region-subscription list
```

### 3. 생성

```bash
./deploy/oci-create-instance.sh
```

| 옵션 | 기본값 | 설명 |
|------|--------|------|
| `--ocpus` / `--memory` | 2 / 12 | A1 배분량. 한도가 4/24 면 `--ocpus 4 --memory 24` |
| `--shape` | `VM.Standard.A1.Flex` | x86 로 갈 땐 `VM.Standard.E2.1.Micro` |
| `--boot-size` | 50 | 부트 볼륨 GB |
| `--ssh-key` | `~/.ssh/nlt_oracle` | 없으면 ed25519 키를 새로 만든다 |
| `--retry-interval` | 300 | 용량 부족 시 재시도 간격(초). 짧으면 Oracle 이 429 로 막는다 |
| `--throttle-wait` | 900 | 429(TooManyRequests) 를 만났을 때 쉬는 시간(초) |
| `--max-attempts` | 40 | `0` 이면 무제한 |
| `--os-version` | 24.04 | Ubuntu 버전 |

A1 은 리전에 따라 몇 시간~며칠씩 용량이 없을 수 있다. 도쿄에서 2 OCPU/12 GB 와
1 OCPU/6 GB 모두 연속 실패한 사례가 있고, 이때 `--shape VM.Standard.E2.1.Micro` 는
첫 시도에 잡혔다. 급하면 Micro 로 시작하고(위 "램이 적은 서버" 절 참고), A1 은
따로 루프를 돌려두는 편이 낫다.

스크립트가 하는 일: SSH 키 준비 → VCN(10.0.0.0/16) · 인터넷 게이트웨이 · 기본 라우팅 →
보안 목록에 22/80/443 수신 규칙 → 퍼블릭 서브넷 → 최신 Ubuntu ARM 이미지 조회 →
인스턴스 생성(용량 부족이면 AD 순환 재시도) → 공인 IP 출력.

끝나면 위 6번 절부터 이어서 진행한다. 콘솔에서 만들 때 필요한 보안 목록 설정(4번 절)은
스크립트가 이미 처리했으므로 건너뛴다.

## 파일

| 파일 | 역할 |
|------|------|
| `oci-create-instance.sh` | OCI CLI 로 네트워크·인스턴스 생성 (용량 부족 자동 재시도) |
| `bootstrap.sh` | 서버 최초 셋업 (패키지 · DB · .env · 방화벽 · nginx). `--http-port` · `--skip-firewall` 지원 |
| `publish.sh` | 빌드 → 정적 파일 동기화 → PM2 재시작 → 헬스 체크 |
| `auto-deploy.sh` | `origin/main` 폴링 → 새 커밋이면 `publish.sh` (systemd 타이머가 실행) |
| `install-auto-deploy.sh` | 자동 배포 타이머 설치 · 제거 (`--interval`, `--uninstall`) |
| `setup-https.sh` | Let's Encrypt 인증서 발급 · https 전환 (경로 A) |
| `cloudflare-tunnel.sh` | Cloudflare Tunnel 생성 · DNS 등록 · systemd 등록 (경로 B) |
| `ecosystem.config.cjs` | PM2 프로세스 정의 (`nlt-server`, `nlt-realtime`) |
| `nginx-nlt.conf.template` | nginx server 블록 템플릿 |
| `nginx-nlt-app.inc` | `/`, `/api/`, `/ws` 라우팅 (server 블록에서 include) |
| `.env.deploy` | bootstrap 이 만드는 로컬 상태(도메인·DB 비밀번호) — 커밋하지 않는다 |
