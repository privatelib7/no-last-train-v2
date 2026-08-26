import { loadSettings, saveSettings } from './settings'

function isSupported() {
  return typeof window !== 'undefined' && 'Notification' in window
}

export type ChromeNotificationStatus = NotificationPermission | 'unsupported'

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

// 자물쇠에서 알림을 허용했는데 게임 설정 토글이 꺼져 있으면 같이 켠다.
// Chrome 권한 창 문구는 바꿀 수 없어서, 허용된 뒤에 앱 설정을 따라가게 한다.
export function enableNotificationPreferenceIfBrowserGranted(): boolean {
  if (!isSupported() || Notification.permission !== 'granted') return false
  if (notificationPreferenceEnabled()) return false
  saveSettings({ ...loadSettings(), notificationsEnabled: true })
  return true
}

// 자물쇠에서 권한을 바꾸면 바로 게임 설정에 반영한다. 구독 해제 함수를 돌려준다.
export function watchBrowserNotificationPermission(): () => void {
  enableNotificationPreferenceIfBrowserGranted()
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) return () => {}

  let status: PermissionStatus | null = null
  const onChange = () => {
    enableNotificationPreferenceIfBrowserGranted()
  }
  const query = navigator.permissions.query({ name: 'notifications' as PermissionName })
  void query.then(result => {
    status = result
    result.addEventListener('change', onChange)
    onChange()
  }).catch(() => {})

  return () => {
    status?.removeEventListener('change', onChange)
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
