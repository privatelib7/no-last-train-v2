/**
 * 도시 방에 접속해 있는 사람들에게 공지를 직접 띄운다 (크롬 알림 + 화면 토스트).
 *
 *   npx tsx --env-file-if-exists=.env scripts/send-notice.ts <도시ID> "메시지" [--info]
 *   npm run notice -w no-last-train-server -- <도시ID> "메시지"
 *
 * 실시간 서버(nlt-realtime)와 같은 Redis(REDIS_URL)를 보고 publish 하므로,
 * 실시간 서버가 떠 있는 호스트나 같은 Redis에 붙을 수 있는 곳에서 실행해야 한다.
 * 크롬 알림은 받는 사람이 설정에서 알림을 켜두고 권한을 허용한 경우에만 뜬다 —
 * 그래서 화면 안 토스트도 함께 간다.
 */
import { publishCityNotice, type CityNoticeLevel } from '../src/lib/city-notice'

function usage(): never {
  console.error('사용법: tsx scripts/send-notice.ts <도시ID> "메시지" [--info]')
  process.exit(2)
}

async function main() {
  const argv = process.argv.slice(2)
  let level: CityNoticeLevel = 'WARNING'
  const rest: string[] = []
  for (const arg of argv) {
    if (arg === '--info') level = 'INFO'
    else if (arg === '--warning') level = 'WARNING'
    else if (arg === '-h' || arg === '--help') usage()
    else rest.push(arg)
  }

  const [cityId, message] = rest
  if (!cityId || !message) usage()

  const receivers = await publishCityNotice({ cityId, level, message })
  if (receivers === 0) {
    console.error('[notice] 이 공지를 받은 실시간 서버가 없다 — nlt-realtime이 같은 REDIS_URL을 보고 있는지 확인해주세요.')
    process.exit(1)
  }
  console.log(`[notice] ${cityId} → 실시간 서버 ${receivers}곳에 전달: ${message}`)
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[notice] 공지 전송 실패', err)
    process.exit(1)
  })
