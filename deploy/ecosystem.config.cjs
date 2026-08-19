// PM2 프로세스 정의 — deploy/publish.sh 가 이 파일로 startOrReload 한다.
//
//   nlt-server   : Next API 서버 (server/.env 의 PORT, 기본 3001)
//   nlt-realtime : 실시간 WebSocket 서버 (REALTIME_PORT, 기본 3012)
//
// 둘 다 server/ 를 cwd 로 두고 node --env-file-if-exists=.env 로 띄우므로
// 환경변수는 server/.env 한 곳만 관리하면 된다.
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..')
const serverDir = path.join(repoRoot, 'server')

// npm workspaces 는 의존성을 루트 node_modules 로 호이스팅하므로 경로를 직접 쓰지 않는다.
let nextBin
try {
  nextBin = require.resolve('next/dist/bin/next', { paths: [serverDir] })
} catch {
  throw new Error('next 모듈을 찾을 수 없다. 저장소 루트에서 npm ci 를 먼저 실행한다.')
}

module.exports = {
  apps: [
    {
      name: 'nlt-server',
      cwd: serverDir,
      script: nextBin,
      args: 'start',
      interpreter: 'node',
      interpreter_args: '--env-file-if-exists=.env',
      env: { NODE_ENV: 'production' },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      max_memory_restart: '1G',
      out_file: path.join(repoRoot, '.logs/pm2/nlt-server.out.log'),
      error_file: path.join(repoRoot, '.logs/pm2/nlt-server.err.log'),
      merge_logs: true,
      time: true,
    },
    {
      name: 'nlt-realtime',
      cwd: serverDir,
      script: 'scripts/realtime-server.ts',
      interpreter: 'node',
      // tsx 로 TS 를 그대로 실행한다 (README 의 프로덕션 실행 방식과 동일)
      interpreter_args: '--env-file-if-exists=.env --import tsx',
      env: { NODE_ENV: 'production' },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      max_memory_restart: '1G',
      out_file: path.join(repoRoot, '.logs/pm2/nlt-realtime.out.log'),
      error_file: path.join(repoRoot, '.logs/pm2/nlt-realtime.err.log'),
      merge_logs: true,
      time: true,
    },
  ],
}
