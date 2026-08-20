# 막차는 없다 — 한 오리진 라우팅 (SPA + /api + /ws)
#
# /etc/nginx/snippets/nlt-app.inc 로 설치되며 server 블록 안에서 include 한다.
# certbot --nginx 이 443 블록을 만들 때 이 include 줄까지 복사하므로,
# http/https 양쪽이 같은 라우팅을 그대로 쓴다.

client_max_body_size 2m;

gzip on;
gzip_comp_level 5;
gzip_min_length 1024;
gzip_proxied any;
gzip_types text/plain text/css application/javascript application/json image/svg+xml;

# Next API 서버 (PM2: nlt-server, 기본 3001)
location /api/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
}

# 실시간 WebSocket (PM2: nlt-realtime, 기본 3012 / ws path = /ws)
location /ws {
    proxy_pass http://127.0.0.1:3012;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    # 좌표 push 연결은 길게 유지된다. 기본 60s면 1분마다 끊긴다.
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

# Vite 빌드 산출물은 파일명에 해시가 붙는다 — 영구 캐시
location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
    try_files $uri =404;
}

# 진입점은 캐시하지 않아야 재배포가 바로 반영된다
location = /index.html {
    add_header Cache-Control "no-cache";
}

location / {
    try_files $uri $uri/ /index.html;
}
