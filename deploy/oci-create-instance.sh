#!/usr/bin/env bash
#
# OCI CLI 로 Always Free 인스턴스를 만든다.
# 네트워크(VCN · 인터넷 게이트웨이 · 라우팅 · 보안 규칙 22/80/443 · 서브넷)가 없으면
# 함께 만들고, "Out of host capacity" 로 실패하면 가용성 도메인을 돌아가며 계속
# 재시도한다. A1 은 용량이 자주 없어서 이 재시도가 사실상 필수다.
#
#   ./deploy/oci-create-instance.sh                       # A1 2 OCPU / 12 GB
#   ./deploy/oci-create-instance.sh --ocpus 4 --memory 24 # 한도가 4/24 인 계정
#   ./deploy/oci-create-instance.sh --shape VM.Standard.E2.1.Micro   # x86 마이크로
#   ./deploy/oci-create-instance.sh --retry-interval 300 --max-attempts 0  # 무한 재시도
#
# 준비: oci CLI + ~/.oci/config (deploy/README.md 의 "부록: OCI CLI 로 인스턴스 만들기")
set -euo pipefail

NAME="nlt"
SHAPE="VM.Standard.A1.Flex"
OCPUS=2
MEMORY=12
BOOT_SIZE=50
OS_NAME="Canonical Ubuntu"
OS_VERSION="24.04"
SSH_KEY="$HOME/.ssh/nlt_oracle"
COMPARTMENT=""
RETRY_INTERVAL=300       # 용량 부족 재시도 간격(초). 너무 짧으면 Oracle 이 429 로 막는다
THROTTLE_WAIT=900        # 429(TooManyRequests) 를 만났을 때 쉬는 시간(초)
MAX_ATTEMPTS=40          # 0 이면 무제한
VCN_NAME="nlt-vcn"
SUBNET_NAME="nlt-subnet"
OCI="${OCI_BIN:-oci}"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)            NAME="$2"; shift 2 ;;
    --shape)           SHAPE="$2"; shift 2 ;;
    --ocpus)           OCPUS="$2"; shift 2 ;;
    --memory)          MEMORY="$2"; shift 2 ;;
    --boot-size)       BOOT_SIZE="$2"; shift 2 ;;
    --os-version)      OS_VERSION="$2"; shift 2 ;;
    --ssh-key)         SSH_KEY="$2"; shift 2 ;;
    --compartment)     COMPARTMENT="$2"; shift 2 ;;
    --retry-interval)  RETRY_INTERVAL="$2"; shift 2 ;;
    --throttle-wait)   THROTTLE_WAIT="$2"; shift 2 ;;
    --max-attempts)    MAX_ATTEMPTS="$2"; shift 2 ;;
    -h|--help)         sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "알 수 없는 인자: $1" ;;
  esac
done

command -v "$OCI" >/dev/null || die "oci CLI 가 없다. OCI_BIN 으로 경로를 주거나 설치한다."
command -v jq >/dev/null || die "jq 가 필요하다: sudo apt-get install -y jq"

# 개인 키 라벨 경고 억제 (동작에는 영향 없음)
export SUPPRESS_LABEL_WARNING=True

CONFIG_FILE="${OCI_CLI_CONFIG_FILE:-$HOME/.oci/config}"
[[ -f "$CONFIG_FILE" ]] || die "$CONFIG_FILE 가 없다. 콘솔에서 API 키를 만들고 설정한다."

TENANCY="$(awk -F'=' '/^[[:space:]]*tenancy[[:space:]]*=/{gsub(/[[:space:]]/,"",$2); print $2; exit}' "$CONFIG_FILE")"
[[ -n "$TENANCY" ]] || die "$CONFIG_FILE 에서 tenancy OCID 를 못 읽었다."
COMPARTMENT="${COMPARTMENT:-$TENANCY}"

# JSON 조회 헬퍼 — 결과가 없으면 빈 문자열
q() { "$OCI" "$@" 2>/dev/null || true; }
none() { [[ -z "$1" || "$1" == "null" ]]; }

log "계정 확인"
# region-subscription 조회는 테넌시 권한이 없으면 막히므로, 인증 확인은 AD 조회로 한다.
region="$(awk -F'=' '/^[[:space:]]*region[[:space:]]*=/{gsub(/[[:space:]]/,"",$2); print $2; exit}' "$CONFIG_FILE")"
probe="$(q iam availability-domain list --compartment-id "$COMPARTMENT" --query 'data[0].name' --raw-output)"
none "$probe" && die "OCI 인증에 실패했다. ~/.oci/config 의 user·tenancy·fingerprint·key_file 을 확인한다."
info "리전     : ${region:-?}"
info "compartment: ${COMPARTMENT:0:24}…"

# ── SSH 키 ─────────────────────────────────────────────────────────────────
if [[ ! -f "$SSH_KEY.pub" ]]; then
  log "SSH 키 생성: $SSH_KEY"
  mkdir -p "$(dirname "$SSH_KEY")"
  ssh-keygen -t ed25519 -N '' -C "nlt-oracle" -f "$SSH_KEY" >/dev/null
  chmod 600 "$SSH_KEY"
fi
info "SSH 키   : $SSH_KEY(.pub)"

# ── 네트워크 ───────────────────────────────────────────────────────────────
log "네트워크 준비"
VCN_ID="$(q network vcn list --compartment-id "$COMPARTMENT" --display-name "$VCN_NAME" --query 'data[0].id' --raw-output)"
if none "$VCN_ID"; then
  info "VCN 생성 ($VCN_NAME, 10.0.0.0/16)"
  VCN_ID="$("$OCI" network vcn create --compartment-id "$COMPARTMENT" \
    --cidr-blocks '["10.0.0.0/16"]' --display-name "$VCN_NAME" --dns-label nltvcn \
    --wait-for-state AVAILABLE --query 'data.id' --raw-output)"
else
  info "VCN 재사용"
fi

IG_ID="$(q network internet-gateway list --compartment-id "$COMPARTMENT" --vcn-id "$VCN_ID" --query 'data[0].id' --raw-output)"
if none "$IG_ID"; then
  info "인터넷 게이트웨이 생성"
  IG_ID="$("$OCI" network internet-gateway create --compartment-id "$COMPARTMENT" --vcn-id "$VCN_ID" \
    --is-enabled true --display-name nlt-ig --wait-for-state AVAILABLE --query 'data.id' --raw-output)"
fi

RT_ID="$("$OCI" network vcn get --vcn-id "$VCN_ID" --query 'data."default-route-table-id"' --raw-output)"
info "기본 라우트 0.0.0.0/0 → 인터넷 게이트웨이"
"$OCI" network route-table update --rt-id "$RT_ID" --force \
  --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IG_ID\"}]" \
  >/dev/null

SL_ID="$("$OCI" network vcn get --vcn-id "$VCN_ID" --query 'data."default-security-list-id"' --raw-output)"
info "수신 규칙 22 · 80 · 443 개방"
"$OCI" network security-list update --security-list-id "$SL_ID" --force \
  --egress-security-rules '[{"destination":"0.0.0.0/0","protocol":"all","isStateless":false}]' \
  --ingress-security-rules '[
    {"protocol":"6","source":"0.0.0.0/0","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":22,"max":22}}},
    {"protocol":"6","source":"0.0.0.0/0","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":80,"max":80}}},
    {"protocol":"6","source":"0.0.0.0/0","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":443,"max":443}}},
    {"protocol":"1","source":"0.0.0.0/0","isStateless":false,"icmpOptions":{"type":3,"code":4}}
  ]' >/dev/null

SUBNET_ID="$(q network subnet list --compartment-id "$COMPARTMENT" --vcn-id "$VCN_ID" --display-name "$SUBNET_NAME" --query 'data[0].id' --raw-output)"
if none "$SUBNET_ID"; then
  info "퍼블릭 서브넷 생성 ($SUBNET_NAME, 10.0.0.0/24)"
  SUBNET_ID="$("$OCI" network subnet create --compartment-id "$COMPARTMENT" --vcn-id "$VCN_ID" \
    --cidr-block 10.0.0.0/24 --display-name "$SUBNET_NAME" --dns-label nltsubnet \
    --prohibit-public-ip-on-vnic false --wait-for-state AVAILABLE --query 'data.id' --raw-output)"
else
  info "서브넷 재사용"
fi

# ── 이미지 ─────────────────────────────────────────────────────────────────
log "이미지 조회: $OS_NAME $OS_VERSION ($SHAPE)"
IMAGE_ID="$(q compute image list --compartment-id "$COMPARTMENT" \
  --operating-system "$OS_NAME" --operating-system-version "$OS_VERSION" --shape "$SHAPE" \
  --sort-by TIMECREATED --sort-order DESC --limit 1 --query 'data[0].id' --raw-output)"
none "$IMAGE_ID" && die "이미지를 찾지 못했다. --os-version 을 바꿔 본다 (예: 22.04)."
IMAGE_NAME="$(q compute image get --image-id "$IMAGE_ID" --query 'data."display-name"' --raw-output)"
info "$IMAGE_NAME"

# ── 가용성 도메인 ──────────────────────────────────────────────────────────
mapfile -t ADS < <("$OCI" iam availability-domain list --compartment-id "$COMPARTMENT" --query 'data[].name' | jq -r '.[]')
[[ ${#ADS[@]} -gt 0 ]] || die "가용성 도메인을 찾지 못했다."
log "가용성 도메인 ${#ADS[@]}개: ${ADS[*]}"

# ── 인스턴스 생성 (용량 부족이면 AD 를 돌며 재시도) ─────────────────────────
launch_args=(
  --compartment-id "$COMPARTMENT"
  --shape "$SHAPE"
  --image-id "$IMAGE_ID"
  --subnet-id "$SUBNET_ID"
  --assign-public-ip true
  --display-name "$NAME"
  --ssh-authorized-keys-file "$SSH_KEY.pub"
  --boot-volume-size-in-gbs "$BOOT_SIZE"
  --wait-for-state RUNNING
)
if [[ "$SHAPE" == *".Flex" ]]; then
  launch_args+=(--shape-config "{\"ocpus\":$OCPUS,\"memoryInGBs\":$MEMORY}")
  log "인스턴스 생성: $NAME / $SHAPE / ${OCPUS} OCPU / ${MEMORY} GB / 부트 ${BOOT_SIZE} GB"
else
  log "인스턴스 생성: $NAME / $SHAPE / 부트 ${BOOT_SIZE} GB"
fi

attempt=0
INSTANCE_ID=""
while :; do
  attempt=$((attempt + 1))
  ad="${ADS[$(( (attempt - 1) % ${#ADS[@]} ))]}"
  printf '    [%s] AD %s … ' "$attempt" "$ad"

  err_file="$(mktemp)"
  if out="$("$OCI" compute instance launch --availability-domain "$ad" "${launch_args[@]}" 2>"$err_file")"; then
    INSTANCE_ID="$(printf '%s' "$out" | jq -r '.data.id')"
    printf '\033[1;32m생성됨\033[0m\n'
    rm -f "$err_file"
    break
  fi

  err="$(cat "$err_file")"; rm -f "$err_file"
  if grep -qiE 'out of (host )?capacity|capacity.*not available' <<<"$err"; then
    printf '용량 없음\n'
  elif grep -qiE 'toomanyrequests|too many requests|"status": *429' <<<"$err"; then
    # Oracle 이 생성 요청 빈도를 제한한 것이다. 재시도 자체는 유효하니 길게 쉬고 계속한다.
    printf '요청 제한(429) — %s초 대기\n' "$THROTTLE_WAIT"
    sleep "$THROTTLE_WAIT"
    continue
  elif grep -qiE 'limitexceeded|exceeded.*limit' <<<"$err"; then
    printf '\n'
    warn "무료 한도를 넘었다는 응답이다. 이미 만든 인스턴스가 있는지 확인한다."
    echo "$err" | tail -5
    exit 1
  else
    printf '\n'
    echo "$err" | tail -20
    die "용량 문제가 아닌 오류다. 위 메시지를 확인한다."
  fi

  if [[ "$MAX_ATTEMPTS" -ne 0 && "$attempt" -ge "$MAX_ATTEMPTS" ]]; then
    die "${MAX_ATTEMPTS}회 시도했지만 용량을 못 잡았다. --retry-interval 을 늘려 다시 돌리거나, --shape VM.Standard.E2.1.Micro 로 시작한다."
  fi
  sleep "$RETRY_INTERVAL"
done

# ── 결과 ───────────────────────────────────────────────────────────────────
PUBLIC_IP="$("$OCI" compute instance list-vnics --instance-id "$INSTANCE_ID" --query 'data[0]."public-ip"' --raw-output)"

cat <<DONE

$(printf '\033[1;32m✔ 인스턴스 준비 완료\033[0m')

  이름     : $NAME
  공인 IP  : $PUBLIC_IP
  SSH 키   : $SSH_KEY
  OCID     : $INSTANCE_ID

접속
  ssh -i $SSH_KEY ubuntu@$PUBLIC_IP

배포 (인스턴스 안에서)
  sudo apt-get update && sudo apt-get install -y git
  git clone <저장소 URL> ~/no-last-train && cd ~/no-last-train
  ./deploy/bootstrap.sh
  ./deploy/publish.sh --seed
  ./deploy/setup-https.sh

DONE
