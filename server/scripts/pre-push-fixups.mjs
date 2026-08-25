#!/usr/bin/env node
// `prisma db push`가 «데이터가 있어서» 못 하는 타입 변경을 미리 해 둔다.
//
// 이 저장소는 prisma migrate를 안 쓰고 db push만 쓴다(로컬 db:prepare, 배포 publish.sh).
// db push는 파괴적 변경을 만나면 --force-reset(DB 전체 삭제)을 권하고 멈춘다. 데이터가
// 있는 DB에서는 그게 유일한 선택지처럼 보이지만, 실제로는 대부분 데이터를 지키면서
// 옮길 수 있다. 그 «옮기는 법»을 여기 적어 둔다.
//
// 규칙
//   - 반드시 여러 번 돌려도 안전해야 한다(이미 옮겨졌으면 아무것도 안 한다).
//   - 새 DB(테이블이 아직 없음)에서도 조용히 넘어가야 한다.
//   - 데이터를 지우지 않는다. 지워야만 하는 변경이면 여기 넣지 말고 사람이 판단한다.

import pg from 'pg'

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('DATABASE_URL이 없다. server/.env를 확인할 것.')
  process.exit(1)
}

// server/src/lib/db.ts와 같은 판별 — sslmode=disable이면 TLS를 끄고 붙는다.
let ssl
try {
  ssl = new URL(connectionString).searchParams.get('sslmode') === 'disable'
    ? false
    : { rejectUnauthorized: false }
} catch {
  ssl = { rejectUnauthorized: false }
}

const client = new pg.Client({ connectionString, ssl })

const fixups = [
  {
    name: 'Line.color: LineColor enum → text',
    // 노선 색을 고정 5색 enum에서 자유로운 #RRGGBB 문자열로 바꿨다.
    // enum→text는 캐스트가 없다며 db push가 거부하지만, 값은 그대로 문자열로 옮겨진다.
    // 'RED' 같은 옛 이름은 resolveLineColor()의 LEGACY_LINE_COLOR_HEX가 헥스로 옮겨 준다.
    async needed(c) {
      const { rows } = await c.query(`
        SELECT udt_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'Line' AND column_name = 'color'
      `)
      return rows[0]?.udt_name === 'LineColor'
    },
    async apply(c) {
      await c.query('ALTER TABLE "Line" ALTER COLUMN "color" DROP DEFAULT')
      await c.query('ALTER TABLE "Line" ALTER COLUMN "color" TYPE text USING "color"::text')
      await c.query('DROP TYPE IF EXISTS "LineColor"')
    },
  },
]

await client.connect()
try {
  let applied = 0
  for (const fixup of fixups) {
    if (!(await fixup.needed(client))) continue
    console.log(`[pre-push] ${fixup.name}`)
    await client.query('BEGIN')
    try {
      await fixup.apply(client)
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    }
    applied += 1
  }
  if (applied === 0) console.log('[pre-push] 옮길 것 없음')
} finally {
  await client.end()
}
