#!/usr/bin/env bash
#
# Let's Encrypt 인증서 발급 + nginx HTTPS 설정 (certbot --nginx).
#
#   ./deploy/setup-https.sh                        # bootstrap 이 정한 도메인 사용
#   ./deploy/setup-https.sh game.example.com you@example.com
#
# 전제
#   - 80 번 포트가 인터넷에서 열려 있어야 한다 (클라우드 보안 목록 + iptables)
#   - 도메인이 이 인스턴스의 공인 IP 를 가리켜야 한다
#     (sslip.io 는 IP 를 그대로 담고 있어 별도 DNS 설정이 필요 없다)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_ENV="$REPO_ROOT/deploy/.env.deploy"

die() { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }
log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

DOMAIN="${1:-}"
EMAIL="${2:-}"

if [[ -z "$DOMAIN" && -f "$DEPLOY_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$DEPLOY_ENV"
  DOMAIN="${NLT_DOMAIN:-}"
fi
[[ -n "$DOMAIN" ]] || die "도메인을 알 수 없다. 인자로 넘긴다: ./deploy/setup-https.sh <domain> [email]"

log "인증서 발급: $DOMAIN"
if [[ -n "$EMAIL" ]]; then
  sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect
else
  # 이메일 없이 발급 — 만료 알림 메일을 못 받는다(자동 갱신은 동작)
  sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
    --register-unsafely-without-email --redirect
fi

log "APP_BASE_URL 을 https 로 갱신"
ENV_FILE="$REPO_ROOT/server/.env"
if grep -q '^APP_BASE_URL=' "$ENV_FILE"; then
  sed -i "s|^APP_BASE_URL=.*|APP_BASE_URL=\"https://${DOMAIN}\"|" "$ENV_FILE"
else
  echo "APP_BASE_URL=\"https://${DOMAIN}\"" >> "$ENV_FILE"
fi

command -v pm2 >/dev/null && pm2 reload nlt-server --update-env >/dev/null 2>&1 || true

log "자동 갱신 타이머"
systemctl list-timers 2>/dev/null | grep -q certbot \
  && echo "    certbot.timer 활성" \
  || echo "    certbot.timer 를 확인한다: systemctl status certbot.timer"

printf '\n\033[1;32m✔ HTTPS 준비 완료\033[0m  https://%s\n\n' "$DOMAIN"
