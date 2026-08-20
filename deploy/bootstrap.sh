#!/usr/bin/env bash
#
# Oracle Cloud 프리티어 인스턴스(Ubuntu 22.04/24.04) 최초 셋업.
# 인스턴스에 SSH로 들어가 저장소를 클론한 뒤 한 번만 실행한다.
#
#   ./deploy/bootstrap.sh                      # 공인 IP 기반 sslip.io 도메인 자동 사용
#   ./deploy/bootstrap.sh --domain game.example.com
#   # 인바운드가 막힌 머신(터널·리버스 프록시 뒤):
#   ./deploy/bootstrap.sh --domain game.example.com --http-port 8080 --skip-firewall
#
# 하는 일
#   1. 시스템 패키지 · Node 22 · PM2 · nginx · certbot 설치
#   2. Docker 로 PostgreSQL 16 · Redis 7 기동 (127.0.0.1 에만 바인딩)
#   3. server/.env 생성 (DB 비밀번호 자동 생성)
#   4. iptables 80/443 개방 + 영구 저장
#   5. nginx 사이트 설치 (아직 정적 파일은 없음 — 이후 deploy/publish.sh)
#
# 여러 번 실행해도 안전하다(이미 된 단계는 건너뛴다).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$REPO_ROOT/deploy"
DEPLOY_ENV="$DEPLOY_DIR/.env.deploy"
NODE_MAJOR=22
FORCE_NGINX=0
SKIP_FIREWALL=0
HTTP_PORT="${HTTP_PORT:-80}"
DOMAIN="${DOMAIN:-}"
WEB_ROOT="${WEB_ROOT:-/var/www/nlt}"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)       DOMAIN="$2"; shift 2 ;;
    --domain=*)     DOMAIN="${1#*=}"; shift ;;
    --web-root)     WEB_ROOT="$2"; shift 2 ;;
    --web-root=*)   WEB_ROOT="${1#*=}"; shift ;;
    --http-port)    HTTP_PORT="$2"; shift 2 ;;
    --http-port=*)  HTTP_PORT="${1#*=}"; shift ;;
    --skip-firewall) SKIP_FIREWALL=1; shift ;;
    --force-nginx)  FORCE_NGINX=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *) die "알 수 없는 인자: $1" ;;
  esac
done

[[ $EUID -ne 0 ]] || die "root 대신 일반 사용자(ubuntu)로 실행한다. 필요한 곳에서만 sudo 를 쓴다."
command -v sudo >/dev/null || die "sudo 가 필요하다."

# ── 기존 설정 재사용 ────────────────────────────────────────────────────────
if [[ -f "$DEPLOY_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$DEPLOY_ENV"
  DOMAIN="${DOMAIN:-${NLT_DOMAIN:-}}"
  WEB_ROOT="${NLT_WEB_ROOT:-$WEB_ROOT}"
fi

# ── 도메인 결정 ─────────────────────────────────────────────────────────────
if [[ -z "$DOMAIN" && $SKIP_FIREWALL -eq 1 ]]; then
  # 터널/프록시 뒤에서는 이 머신의 공인 IP 가 접속 주소가 아니다
  DOMAIN="localhost"
fi
if [[ -z "$DOMAIN" ]]; then
  log "공인 IP 확인"
  PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  if [[ -z "$PUBLIC_IP" ]]; then
    PUBLIC_IP="$(curl -fsS --max-time 5 -H 'Authorization: Bearer Oracle' \
      http://169.254.169.254/opc/v2/vnics/ 2>/dev/null \
      | grep -oE '"publicIp"[^,]*' | head -1 | grep -oE '[0-9.]+' || true)"
  fi
  [[ -n "$PUBLIC_IP" ]] || die "공인 IP 를 알아내지 못했다. --domain 으로 직접 지정한다."
  # sslip.io: 별도 가입 없이 IP 를 그대로 가리키는 도메인 (1.2.3.4 -> 1-2-3-4.sslip.io).
  # HTTP 로는 바로 쓸 수 있지만 PSL 에 없어 Let's Encrypt 발급량을 도메인 전체가
  # 공유한다 — HTTPS 가 필요하면 --domain 으로 DuckDNS/보유 도메인을 주는 편이 안전하다.
  DOMAIN="${PUBLIC_IP//./-}.sslip.io"
  echo "    공인 IP: $PUBLIC_IP"
fi
echo "    도메인 : $DOMAIN"
echo "    웹 루트: $WEB_ROOT"

# ── 1. 시스템 패키지 ────────────────────────────────────────────────────────
log "시스템 패키지 설치"
export DEBIAN_FRONTEND=noninteractive
pkgs=(ca-certificates curl git rsync openssl nginx)
# docker 가 이미 있으면 건드리지 않는다 (docker-ce 를 docker.io 로 갈아끼우면 기존 컨테이너가 깨진다)
command -v docker >/dev/null || pkgs+=(docker.io)
if [[ $SKIP_FIREWALL -eq 0 ]]; then
  pkgs+=(iptables-persistent netfilter-persistent certbot python3-certbot-nginx)
fi
sudo apt-get update -y
sudo apt-get install -y "${pkgs[@]}"

# ── 2. Node.js ─────────────────────────────────────────────────────────────
current_major="$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || echo 0)"
if [[ "${current_major:-0}" -lt "$NODE_MAJOR" ]]; then
  log "Node.js ${NODE_MAJOR}.x 설치"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
else
  log "Node.js $(node -v) 확인"
fi

# ── 3. PM2 ─────────────────────────────────────────────────────────────────
if ! command -v pm2 >/dev/null; then
  log "PM2 설치 + 부팅 시 자동 기동 등록"
  sudo npm install -g pm2
  sudo env PATH="$PATH" pm2 startup systemd -u "$USER" --hp "$HOME"
else
  log "PM2 $(pm2 -v) 확인"
fi

# ── 4. 스왑 (메모리 4GB 미만 인스턴스용) ─────────────────────────────────────
mem_kb="$(awk '/MemTotal/{print $2}' /proc/meminfo)"
if (( mem_kb < 4000000 )) && [[ ! -f /swapfile ]]; then
  log "스왑 2GB 생성 (메모리 $((mem_kb / 1024))MB)"
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# ── 5. 방화벽 (인스턴스 내부) ───────────────────────────────────────────────
# Oracle 의 Ubuntu 이미지는 INPUT 체인 끝에 REJECT 규칙이 있어, 그 앞에 넣어야 한다.
# 클라우드 콘솔의 보안 목록(수신 규칙)도 따로 열어야 한다 — deploy/README.md 참고.
sudo systemctl enable --now docker >/dev/null 2>&1 || true
if [[ $SKIP_FIREWALL -eq 1 ]]; then
  log "방화벽 설정 건너뜀 (--skip-firewall)"
else
log "iptables 80/443 개방"
for port in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    sudo iptables -I INPUT -p tcp --dport "$port" -j ACCEPT
  fi
done
sudo netfilter-persistent save
if sudo ufw status 2>/dev/null | grep -q '^Status: active'; then
  sudo ufw allow 80/tcp
  sudo ufw allow 443/tcp
fi
fi

# ── 6. PostgreSQL · Redis 컨테이너 ─────────────────────────────────────────
mkdir -p "$DEPLOY_DIR"
if [[ ! -f "$DEPLOY_ENV" ]]; then
  DB_PASSWORD="$(openssl rand -hex 16)"
  umask 077
  cat > "$DEPLOY_ENV" <<ENVEOF
# deploy/bootstrap.sh 가 생성 — 커밋하지 않는다.
NLT_DOMAIN="$DOMAIN"
NLT_WEB_ROOT="$WEB_ROOT"
NLT_HTTP_PORT="$HTTP_PORT"
NLT_DB_PASSWORD="$DB_PASSWORD"
ENVEOF
  umask 022
else
  # shellcheck disable=SC1090
  source "$DEPLOY_ENV"
  DB_PASSWORD="$NLT_DB_PASSWORD"
  # 도메인이 바뀌었으면 갱신
  sed -i "s|^NLT_DOMAIN=.*|NLT_DOMAIN=\"$DOMAIN\"|" "$DEPLOY_ENV" 2>/dev/null || true
fi

if ! sudo docker ps -a --format '{{.Names}}' | grep -qx nlt-postgres; then
  log "PostgreSQL 16 컨테이너 생성"
  sudo docker run -d --name nlt-postgres --restart unless-stopped \
    -e POSTGRES_USER=nlt \
    -e POSTGRES_PASSWORD="$DB_PASSWORD" \
    -e POSTGRES_DB=no_last_train \
    -p 127.0.0.1:5432:5432 \
    -v nlt-pgdata:/var/lib/postgresql/data \
    postgres:16
else
  log "PostgreSQL 컨테이너 확인"
  sudo docker start nlt-postgres >/dev/null 2>&1 || true
fi

if ! sudo docker ps -a --format '{{.Names}}' | grep -qx nlt-redis; then
  log "Redis 7 컨테이너 생성"
  sudo docker run -d --name nlt-redis --restart unless-stopped \
    -p 127.0.0.1:6379:6379 \
    -v nlt-redisdata:/data \
    redis:7 redis-server --save 60 1 --appendonly no
else
  log "Redis 컨테이너 확인"
  sudo docker start nlt-redis >/dev/null 2>&1 || true
fi

# ── 7. server/.env ─────────────────────────────────────────────────────────
ENV_FILE="$REPO_ROOT/server/.env"
base_url="http://${DOMAIN}"
[[ "$HTTP_PORT" == "80" ]] || base_url="${base_url}:${HTTP_PORT}"
if [[ ! -f "$ENV_FILE" ]]; then
  log "server/.env 생성"
  # sslmode=disable: 로컬 Docker PostgreSQL 은 TLS 를 쓰지 않는다.
  # 이 값이 없으면 서버가 SSL 연결을 시도해 "server does not support SSL" 로 실패한다.
  cat > "$ENV_FILE" <<ENVEOF
PORT="3001"
REALTIME_PORT="3012"
DATABASE_URL="postgresql://nlt:${DB_PASSWORD}@127.0.0.1:5432/no_last_train?sslmode=disable"
REDIS_URL="redis://127.0.0.1:6379"
APP_BASE_URL="${base_url}"

# 선택 항목 — 필요할 때 채운다 (server/.env.example 주석 참고)
# OPENAI_API_KEY=""
# ANTHROPIC_API_KEY=""
# GMAIL_USER=""
# GMAIL_APP_PASSWORD=""
ENVEOF
  chmod 600 "$ENV_FILE"
else
  log "server/.env 이미 있음 — 건드리지 않는다"
fi

# ── 8. nginx 사이트 ────────────────────────────────────────────────────────
log "nginx 사이트 설치"
sudo mkdir -p "$WEB_ROOT"
sudo chown -R "$USER":"$USER" "$WEB_ROOT"
sudo install -D -m 644 "$DEPLOY_DIR/nginx-nlt-app.inc" /etc/nginx/snippets/nlt-app.inc

site=/etc/nginx/sites-available/nlt
if [[ -f "$site" ]] && sudo grep -q 'managed by Certbot' "$site" && [[ $FORCE_NGINX -eq 0 ]]; then
  warn "$site 에 certbot 설정이 있어 덮어쓰지 않는다 (덮어쓰려면 --force-nginx)"
else
  sed -e "s|__SERVER_NAME__|$DOMAIN|g" -e "s|__WEB_ROOT__|$WEB_ROOT|g" -e "s|__HTTP_PORT__|$HTTP_PORT|g" \
    "$DEPLOY_DIR/nginx-nlt.conf.template" | sudo tee "$site" >/dev/null
fi
sudo ln -sfn "$site" /etc/nginx/sites-enabled/nlt
sudo rm -f /etc/nginx/sites-enabled/default

if [[ ! -f "$WEB_ROOT/index.html" ]]; then
  echo '<!doctype html><meta charset="utf-8"><title>막차는 없다</title><p>배포 준비 중 — deploy/publish.sh 를 실행한다.' \
    > "$WEB_ROOT/index.html"
fi

sudo nginx -t
sudo systemctl reload nginx

cat <<DONE

$(printf '\033[1;32m✔ 셋업 완료\033[0m')

  주소        : $DOMAIN:$HTTP_PORT
  웹 루트     : $WEB_ROOT
  DB          : postgresql://nlt:***@127.0.0.1:5432/no_last_train (docker: nlt-postgres)
  Redis       : redis://127.0.0.1:6379 (docker: nlt-redis)
  환경변수    : $REPO_ROOT/server/.env

다음 단계
  1) 클라우드 콘솔 보안 목록에 80/443 수신 규칙이 있는지 확인
  2) ./deploy/publish.sh --seed     # 빌드 · 스키마 반영 · 초기 데이터 · PM2 기동
  3) ./deploy/setup-https.sh        # Let's Encrypt 인증서 (선택이지만 권장)

DONE
