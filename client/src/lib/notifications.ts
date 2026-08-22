function isSupported() {
  return typeof window !== 'undefined' && 'Notification' in window
}

export type ChromeNotificationStatus = NotificationPermission | 'unsupported'

export type PresenceMember = {
  playerId: string
  nickname: string
}

export function newlyJoinedPlayers<T extends PresenceMember>(
  knownPlayerIds: ReadonlySet<string>,
  nextPlayers: T[],
): T[] {
  return nextPlayers.filter(player => !knownPlayerIds.has(player.playerId))
}

export function getChromeNotificationStatus(): ChromeNotificationStatus {
  return isSupported() ? Notification.permission : 'unsupported'
}

// 권한 요청은 반드시 설정 토글의 사용자 클릭 안에서 실행한다. 게임 이벤트 effect에서
// requestPermission()을 호출하면 Chrome이 사용자 제스처가 아니라고 보고 차단할 수 있다.
export async function requestChromeNotificationPermission(): Promise<ChromeNotificationStatus> {
  if (!isSupported()) return 'unsupported'
  if (Notification.permission !== 'default') return Notification.permission
  return Notification.requestPermission()
}

function notificationPreferenceEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem('nlt.settings')
    if (!raw) return false
    return (JSON.parse(raw) as { notificationsEnabled?: boolean }).notificationsEnabled === true
  } catch {
    return false
  }
}

// 파산 위험·게임오버 같은 응급 상황이 발생한 순간 크롬 알림을 한 번 띄운다.
// tag를 상황별로 고유하게 주면(예: `nlt-cash-${cityId}`) 알림이 중복으로 쌓이지 않는다.
export async function notifyEmergency(title: string, body: string, tag: string): Promise<void> {
  if (!isSupported() || !notificationPreferenceEnabled() || Notification.permission !== 'granted') return
  try {
    new Notification(title, { body, icon: '/favicon.svg', tag })
  } catch {
    // 일부 환경에서 Notification 생성 실패 시 무시
  }
}
