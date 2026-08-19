#!/usr/bin/env bash
#
# Cloudflare Tunnel 로 이 머신의 nginx 를 공개 URL 에 붙인다.
# 인바운드 포트를 열 수 없는 환경(외부 IP 없음 · 방화벽 권한 없음)에서 쓴다.
#
#   ./deploy/cloudflare-tunnel.sh game.example.com
#   ./deploy/cloudflare-tunnel.sh game.example.com --port 8080 --name nlt
#
# 전제: 해당 도메인이 Cloudflare 에 존재하는 zone 이어야 한다(네임서버가 Cloudflare).
# 최초 1회는 브라우저 로그인(cloudflared tunnel login)이 필요하다.
set -euo pipefail

HOSTNAME_ARG="${1:-}"
shift || true
PORT=8080
TUNNEL_NAME="nlt"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --name) TUNNEL_NAME="$2"; shift 2 ;;
    *) die "알 수 없는 인자: $1" ;;
  esac
done

[[ -n "$HOSTNAME_ARG" ]] || die "사용법: ./deploy/cloudflare-tunnel.sh <hostname> [--port 8080] [--name nlt]"
command -v cloudflared >/dev/null || die "cloudflared 가 없다. deploy/README.md 의 터널 절을 참고해 설치한다."

CF_DIR="$HOME/.cloudflared"
mkdir -p "$CF_DIR"

# ── 1. 계정 인증 (브라우저) ────────────────────────────────────────────────
if [[ ! -f "$CF_DIR/cert.pem" ]]; then
  log "Cloudflare 로그인"
  info "아래 URL 을 브라우저에서 열고 도메인을 선택한다."
  cloudflared tunnel login
fi
[[ -f "$CF_DIR/cert.pem" ]] || die "로그인이 끝나지 않았다 ($CF_DIR/cert.pem 없음)."

# ── 2. 터널 생성 ───────────────────────────────────────────────────────────
TUNNEL_ID="$(cloudflared tunnel list --output json 2>/dev/null \
  | jq -r --arg n "$TUNNEL_NAME" '.[] | select(.name==$n) | .id' | head -1)"
if [[ -z "$TUNNEL_ID" ]]; then
  log "터널 생성: $TUNNEL_NAME"
  cloudflared tunnel create "$TUNNEL_NAME"
  TUNNEL_ID="$(cloudflared tunnel list --output json | jq -r --arg n "$TUNNEL_NAME" '.[] | select(.name==$n) | .id' | head -1)"
fi
[[ -n "$TUNNEL_ID" ]] || die "터널 ID 를 확인하지 못했다."
info "터널 ID: $TUNNEL_ID"

# ── 3. 설정 파일 ───────────────────────────────────────────────────────────
log "설정 파일 작성: $CF_DIR/config.yml"
cat > "$CF_DIR/config.yml" <<YAML
tunnel: $TUNNEL_ID
credentials-file: $CF_DIR/$TUNNEL_ID.json

# WebSocket(/ws)은 cloudflared 가 기본으로 통과시킨다.
ingress:
  - hostname: $HOSTNAME_ARG
    service: http://localhost:$PORT
  - service: http_status:404
YAML
cat "$CF_DIR/config.yml" | sed 's/^/    /'

# ── 4. DNS 레코드 ──────────────────────────────────────────────────────────
log "DNS 연결: $HOSTNAME_ARG → 터널"
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME_ARG" 2>&1 | tail -2 || true

# ── 5. 상시 실행 (systemd) ─────────────────────────────────────────────────
log "systemd 서비스 등록"
if systemctl list-unit-files 2>/dev/null | grep -q '^cloudflared.service'; then
  sudo cp "$CF_DIR/config.yml" /etc/cloudflared/config.yml
  sudo cp "$CF_DIR/$TUNNEL_ID.json" /etc/cloudflared/
  sudo systemctl restart cloudflared
else
  sudo cloudflared --config "$CF_DIR/config.yml" service install
fi
sleep 3
systemctl is-active --quiet cloudflared && info "cloudflared 실행 중" || info "상태 확인: sudo systemctl status cloudflared"

printf '\n\033[1;32m✔ 터널 준비 완료\033[0m  https://%s\n\n' "$HOSTNAME_ARG"
