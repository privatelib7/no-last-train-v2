#!/usr/bin/env bash
#
# 빌드 → 정적 파일 동기화 → PM2 재시작. 인스턴스에서 실행한다.
#
#   ./deploy/publish.sh              # 평소 재배포
#   ./deploy/publish.sh --pull       # git pull 후 배포
#   ./deploy/publish.sh --seed       # 최초 1회: 초기 데이터(시드) 포함
#   ./deploy/publish.sh --skip-install
#
# 주의: --seed 는 시연용 도시 데이터를 다시 만든다(기존 도시 일부를 지운다).
#       운영 중인 서버에는 쓰지 않는다.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_ENV="$REPO_ROOT/deploy/.env.deploy"
WEB_ROOT="${WEB_ROOT:-/var/www/nlt}"
DO_PULL=0
DO_SEED=0
SKIP_INSTALL=0

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pull)         DO_PULL=1; shift ;;
    --seed)         DO_SEED=1; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    --web-root)     WEB_ROOT="$2"; shift 2 ;;
    -h|--help)      sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "알 수 없는 인자: $1" ;;
  esac
done

if [[ -f "$DEPLOY_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$DEPLOY_ENV"
  WEB_ROOT="${NLT_WEB_ROOT:-$WEB_ROOT}"
fi

cd "$REPO_ROOT"
[[ -f server/.env ]] || die "server/.env 가 없다. deploy/bootstrap.sh 를 먼저 실행한다."
command -v pm2 >/dev/null || die "pm2 가 없다. deploy/bootstrap.sh 를 먼저 실행한다."

if [[ $DO_PULL -eq 1 ]]; then
  log "git pull"
  git pull --ff-only
fi

if [[ $SKIP_INSTALL -eq 0 ]]; then
  log "의존성 설치 (npm ci)"
  # devDependencies 도 필요하다 (tsx, prisma, next 빌드, @opennextjs/cloudflare 타입)
  npm ci
fi

log "Prisma 클라이언트 생성 · 스키마 반영"
( cd server && npx prisma generate && npx prisma db push )

if [[ $DO_SEED -eq 1 ]]; then
  log "초기 데이터 시드"
  ( cd server && npx tsx prisma/seed.ts )
fi

log "API 서버 빌드 (next build)"
npm run build:next -w no-last-train-server

log "프론트 빌드 (vite build)"
npm run build:client

log "정적 파일 동기화 → $WEB_ROOT"
[[ -d client/dist ]] || die "client/dist 가 없다. 프론트 빌드가 실패했다."
if [[ -w "$WEB_ROOT" ]]; then
  rsync -a --delete client/dist/ "$WEB_ROOT/"
else
  sudo rsync -a --delete client/dist/ "$WEB_ROOT/"
fi

log "PM2 기동/재시작"
mkdir -p "$REPO_ROOT/.logs/pm2"
pm2 startOrReload deploy/ecosystem.config.cjs --update-env
pm2 save

# ── 헬스 체크 ──────────────────────────────────────────────────────────────
log "헬스 체크"
api_port="$(grep -oE '^PORT="?[0-9]+' server/.env | grep -oE '[0-9]+' || echo 3001)"
rt_port="$(grep -oE '^REALTIME_PORT="?[0-9]+' server/.env | grep -oE '[0-9]+' || echo 3012)"
http_port="${NLT_HTTP_PORT:-80}"   # bootstrap 의 --http-port (deploy/.env.deploy)

check() { # name url
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 "$2" >/dev/null 2>&1; then
      printf '    \033[1;32m✔\033[0m %s\n' "$1"
      return 0
    fi
    sleep 1
  done
  printf '    \033[1;31m✘\033[0m %s (%s)\n' "$1" "$2"
  return 1
}

failed=0
check "API      /api/health"  "http://127.0.0.1:${api_port}/api/health" || failed=1
check "realtime /health"      "http://127.0.0.1:${rt_port}/health"      || failed=1
check "nginx    /"            "http://127.0.0.1:${http_port}/"           || failed=1

if [[ $failed -ne 0 ]]; then
  echo
  echo "로그: pm2 logs nlt-server --lines 50 / pm2 logs nlt-realtime --lines 50"
  exit 1
fi

url="http://${NLT_DOMAIN:-localhost}$([[ "${NLT_HTTP_PORT:-80}" != "80" ]] && echo ":${NLT_HTTP_PORT}")"
# certbot 이 443 블록을 만들어 뒀으면 https 주소를 안내한다
if [[ -n "${NLT_DOMAIN:-}" ]] && grep -qs 'listen 443' /etc/nginx/sites-available/nlt; then
  url="https://${NLT_DOMAIN}"
fi
printf '\n\033[1;32m✔ 배포 완료\033[0m  %s\n\n' "$url"
