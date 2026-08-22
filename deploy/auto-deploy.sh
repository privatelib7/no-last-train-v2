#!/usr/bin/env bash
#
# origin/main 에 새 커밋이 올라오면 배포한다.
# systemd 타이머(nlt-auto-deploy.timer)가 주기적으로 이 스크립트를 실행한다.
#
#   ./deploy/auto-deploy.sh           # 새 커밋이 있을 때만 배포
#   ./deploy/auto-deploy.sh --force   # 커밋이 같아도 다시 배포
#
# 설치: ./deploy/install-auto-deploy.sh
# 로그: journalctl -u nlt-auto-deploy -f
#
# 이 스크립트는 배포 도중 git reset 으로 자기 자신을 덮어쓸 수 있다. bash 는
# 파일을 조각내어 읽으므로 본문을 main() 에 모아 두고 마지막 줄에서 호출한다.
# 그래야 실행 전에 전체가 파싱되어 도중에 바뀌어도 깨지지 않는다.
set -euo pipefail

log() { printf '%s  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

main() {
  local repo_root branch force=0 local_sha remote_sha

  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  branch="${NLT_DEPLOY_BRANCH:-main}"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force)   force=1; shift ;;
      -h|--help) sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; return 0 ;;
      *)         log "[x] 알 수 없는 인자: $1"; return 2 ;;
    esac
  done

  cd "$repo_root"

  # 배포가 겹치지 않게 잠근다. 앞 회차가 아직 돌고 있으면 이번 회차는 넘어간다.
  mkdir -p "$repo_root/.logs"
  exec 9>"$repo_root/.logs/auto-deploy.lock"
  if ! flock -n 9; then
    log "앞 배포가 아직 실행 중이다 — 이번 회차는 건너뛴다"
    return 0
  fi

  if ! git fetch --quiet origin "$branch"; then
    log "[x] git fetch 실패 — 네트워크나 자격증명을 확인한다 (gh auth status)"
    return 1
  fi

  local_sha="$(git rev-parse HEAD)"
  # FETCH_HEAD 대신 원격 추적 ref 를 본다 — 다른 워크트리의 fetch 와 섞이지 않는다.
  if ! remote_sha="$(git rev-parse --verify --quiet "refs/remotes/origin/$branch")"; then
    log "[x] origin/$branch 를 찾을 수 없다"
    return 1
  fi

  # 새 커밋이 없으면 아무것도 남기지 않는다. 1 분마다 도는 로그를 더럽히지 않는다.
  if [[ "$local_sha" == "$remote_sha" && $force -eq 0 ]]; then
    return 0
  fi

  log "배포 시작 ${local_sha:0:7} → ${remote_sha:0:7} — $(git log -1 --format=%s "$remote_sha")"

  # 프로덕션 체크아웃은 origin/$branch 만 따라가는 detached HEAD 다. 로컬 편집이
  # 없다고 보고 hard reset 한다 — force push 나 롤백도 그대로 따라간다.
  git reset --hard --quiet "$remote_sha"

  if ! ./deploy/publish.sh; then
    log "[x] 배포 실패 ${remote_sha:0:7} — pm2 logs nlt-server --lines 50"
    return 1
  fi

  log "[✔] 배포 완료 ${remote_sha:0:7}"
}

main "$@"
