#!/usr/bin/env bash
#
# Deploys the image toolkit to the VPS as a Docker container behind the nginx
# that already serves kevinvarghese.in.
#
# Safety is the point of most of what follows: the existing site is live, so
# the nginx config is backed up, validated with `nginx -t`, and only reloaded
# if that passes. A failed validation restores the backup and changes nothing.
#
# Idempotent — run it again to redeploy.
set -euo pipefail

HOST="${HOST:-root@200.234.34.123}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/kv_vps_deploy}"
APP_BASE="${APP_BASE:-/heic/}"
PORT="${PORT:-8081}"
NAME="${NAME:-heic-toolkit}"
REMOTE_DIR="${REMOTE_DIR:-/opt/$NAME}"
SITE_CONF="${SITE_CONF:-}"   # auto-detected when empty

SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new $HOST"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "Checking the server"
$SSH 'command -v docker >/dev/null || { echo "MISSING:docker"; exit 90; }
      command -v nginx  >/dev/null || { echo "MISSING:nginx";  exit 91; }
      docker info >/dev/null 2>&1  || { echo "MISSING:docker-daemon"; exit 92; }
      echo "docker $(docker --version | awk "{print \$3}" | tr -d ,) / nginx ok"'

say "Checking port $PORT is free"
$SSH "ss -ltn 2>/dev/null | grep -q ':$PORT ' && { echo \"Port $PORT already in use\"; exit 93; } || echo 'free'" \
  || { echo "Pick another port with PORT=xxxx"; exit 1; }

say "Uploading source (excluding node_modules, dist, binaries)"
rsync -az --delete \
  -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new" \
  --exclude node_modules --exclude dist --exclude .git \
  --exclude public/models --exclude public/ort --exclude .vercel \
  ./ "$HOST:$REMOTE_DIR/"

say "Building the image on the server (downloads the 28MB model)"
$SSH "cd $REMOTE_DIR && docker build \
  --build-arg APP_BASE=$APP_BASE \
  -f deploy/Dockerfile -t $NAME:latest ."

say "Starting the container"
$SSH "docker rm -f $NAME >/dev/null 2>&1 || true
      docker run -d --name $NAME --restart unless-stopped \
        -p 127.0.0.1:$PORT:80 $NAME:latest"

say "Waiting for the container to answer"
$SSH "for i in \$(seq 1 30); do
        curl -fsS -o /dev/null http://127.0.0.1:$PORT/index.html && { echo 'container healthy'; exit 0; }
        sleep 1
      done
      echo 'container did not come up'; docker logs --tail 40 $NAME; exit 94"

say "Wiring nginx"
$SSH "set -e
CONF='$SITE_CONF'
if [ -z \"\$CONF\" ]; then
  # The vhost that actually owns the domain, whatever it happens to be called.
  CONF=\$(grep -rl 'kevinvarghese\\.in' /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null | head -1)
fi
[ -n \"\$CONF\" ] || { echo 'Could not find the nginx vhost for kevinvarghese.in'; exit 95; }
echo \"vhost: \$CONF\"

if grep -q 'location /heic/' \"\$CONF\"; then
  echo 'location block already present — leaving it alone'
else
  cp \"\$CONF\" \"\$CONF.bak.\$(date +%s)\"
  # Insert into the TLS server block, before its closing brace.
  python3 - \"\$CONF\" $PORT <<'PY'
import sys, re
path, port = sys.argv[1], sys.argv[2]
src = open(path).read()
block = '''
    # Image toolkit (Docker container on 127.0.0.1:%s)
    location = /heic { return 301 /heic/; }
    location /heic/ {
        proxy_pass http://127.0.0.1:%s/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        # 28MB model file; no buffering to disk and no premature timeout.
        proxy_buffering off;
        proxy_read_timeout 300s;
        client_max_body_size 1m;
    }
''' % (port, port)

# Prefer the server block listening on 443; fall back to the last one.
starts = [m.start() for m in re.finditer(r'server\\s*{', src)]
target = None
for s in starts:
    depth, i = 0, s
    while i < len(src):
        if src[i] == '{': depth += 1
        elif src[i] == '}':
            depth -= 1
            if depth == 0: break
        i += 1
    if 'listen' in src[s:i] and '443' in src[s:i]:
        target = i
        break
if target is None:
    s = starts[-1]; depth, i = 0, s
    while i < len(src):
        if src[i] == '{': depth += 1
        elif src[i] == '}':
            depth -= 1
            if depth == 0: break
        i += 1
    target = i
open(path, 'w').write(src[:target] + block + src[target:])
print('inserted')
PY
fi

if nginx -t 2>&1; then
  nginx -s reload
  echo 'nginx reloaded'
else
  LATEST=\$(ls -t \"\$CONF\".bak.* 2>/dev/null | head -1)
  if [ -n \"\$LATEST\" ]; then cp \"\$LATEST\" \"\$CONF\"; echo 'config test FAILED — restored backup, nothing changed'; fi
  exit 96
fi"

say "Verifying from the outside"
sleep 2
code=$(curl -s -o /dev/null -w '%{http_code}' "https://kevinvarghese.in${APP_BASE}")
root=$(curl -s -o /dev/null -w '%{http_code}' "https://kevinvarghese.in/")
echo "  https://kevinvarghese.in${APP_BASE} -> $code"
echo "  https://kevinvarghese.in/ (existing site) -> $root"
[ "$code" = "200" ] && [ "$root" = "200" ] && say "Deployed: https://kevinvarghese.in${APP_BASE}" || { echo "Something is off — check above."; exit 1; }
