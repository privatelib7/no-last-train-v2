#!/usr/bin/env bash
#
# origin/main 자동 배포를 systemd 타이머로 설치한다. 프로덕션 체크아웃에서 실행한다.
#
#   ./deploy/install-auto-deploy.sh                  # 설치·활성화 (1 분 간격)
#   ./deploy/install-auto-deploy.sh --interval 5min  # 폴링 간격 변경
#   ./deploy/install-auto-deploy.sh --uninstall      # 제거
#
# 유닛 파일을 /etc/systemd/system 에 두므로 sudo 가 필요하다.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="nlt-auto-deploy"
INTERVAL="1min"
ACTION="install"
RUN_USER="$(id -un)"
RUN_GROUP="$(id -gn)"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval)  INTERVAL="$2"; shift 2 ;;
    --uninstall) ACTION="uninstall"; shift ;;
    -h|--help)   sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "알 수 없는 인자: $1" ;;
  esac
done

if [[ "$ACTION" == "uninstall" ]]; then
  log "타이머 중지·유닛 제거"
  sudo systemctl disable --now "$UNIT.timer" 2>/dev/null || true
  sudo rm -f "/etc/systemd/system/$UNIT.timer" "/etc/systemd/system/$UNIT.service"
  sudo systemctl daemon-reload
  printf '\n\033[1;32m✔ 자동 배포를 제거했다\033[0m\n\n'
  exit 0
fi

# ── 사전 점검 ────────────────────────────────────────────────────────────────
[[ -x "$REPO_ROOT/deploy/auto-deploy.sh" ]] || die "deploy/auto-deploy.sh 가 없거나 실행 권한이 없다."
[[ -f "$REPO_ROOT/server/.env" ]] || die "server/.env 가 없다. deploy/bootstrap.sh 를 먼저 실행한다."
command -v pm2   >/dev/null || die "pm2 가 없다. deploy/bootstrap.sh 를 먼저 실행한다."
command -v flock >/dev/null || die "flock 이 없다 (util-linux 를 설치한다)."

head_branch="$(git -C "$REPO_ROOT" symbolic-ref --quiet --short HEAD || true)"
if [[ -n "$head_branch" ]]; then
  printf '\033[1;33m[!] 이 체크아웃은 %s 브랜치에 붙어 있다. 자동 배포는 origin/main 으로 hard reset 하므로\n    이 브랜치가 함께 끌려간다. 프로덕션 전용 체크아웃은 detached HEAD 를 권한다.\033[0m\n' "$head_branch"
fi

# ── 유닛 설치 ────────────────────────────────────────────────────────────────
log "유닛 설치 → /etc/systemd/system/$UNIT.{service,timer}"

sudo tee "/etc/systemd/system/$UNIT.service" >/dev/null <<UNIT_EOF
# deploy/install-auto-deploy.sh 가 생성한다. 직접 고치지 말고 스크립트를 다시 실행한다.
[Unit]
Description=no-last-train 자동 배포 (origin/main 폴링)
Documentation=file://$REPO_ROOT/deploy/README.md
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$REPO_ROOT
Environment=HOME=$HOME
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$REPO_ROOT/deploy/auto-deploy.sh
# npm ci + next/vite 빌드까지 도는 시간을 넉넉히 잡는다
TimeoutStartSec=1800
# 빌드가 돌아가는 게임 서버의 CPU 를 뺏지 않게 한다
Nice=10
UNIT_EOF

sudo tee "/etc/systemd/system/$UNIT.timer" >/dev/null <<TIMER_EOF
# deploy/install-auto-deploy.sh 가 생성한다. 직접 고치지 말고 스크립트를 다시 실행한다.
[Unit]
Description=no-last-train 자동 배포 타이머 ($INTERVAL 마다 origin/main 확인)

[Timer]
Unit=$UNIT.service
OnBootSec=2min
# 앞 회차가 "끝난 뒤" 부터 세므로 배포끼리 겹치지 않는다
OnUnitActiveSec=$INTERVAL
AccuracySec=10s

[Install]
WantedBy=timers.target
TIMER_EOF

sudo systemctl daemon-reload
sudo systemctl enable --now "$UNIT.timer"

log "상태"
systemctl list-timers "$UNIT.timer" --no-pager || true

printf '\n\033[1;32m✔ 자동 배포 설치 완료\033[0m — %s 마다 origin/main 을 확인한다\n\n' "$INTERVAL"
printf '   로그      journalctl -u %s -f\n'            "$UNIT"
printf '   즉시 배포 sudo systemctl start %s.service\n' "$UNIT"
printf '   일시 중지 sudo systemctl stop %s.timer\n'    "$UNIT"
printf '   제거      ./deploy/install-auto-deploy.sh --uninstall\n\n'
