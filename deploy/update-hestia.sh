#!/usr/bin/env bash
set -euo pipefail
if [[ $(id -u) != 0 ]]; then echo 'Run as root'; exit 1; fi
APP_DIR=/home/arbit/web/clicknlist.uk.to/public_html
PRIVATE_DIR=/home/arbit/web/clicknlist.uk.to/private
CONF_DIR=/home/arbit/conf/web/clicknlist.uk.to
STAMP=$(date +%Y%m%d-%H%M%S)
cd "$APP_DIR"
# Validate the code before touching running services.
sudo -u arbit -H npm ci --omit=dev --ignore-scripts
sudo -u arbit -H /usr/bin/node --test tests/*.test.ts
install -d -o arbit -g arbit -m 700 "$PRIVATE_DIR/exchange-data"
if [[ ! -f "$PRIVATE_DIR/exchange.env" ]]; then
  umask 077
  /usr/bin/node --input-type=module -e 'import {randomBytes} from "node:crypto"; console.log("ADMIN_KEY="+randomBytes(32).toString("hex"));' > "$PRIVATE_DIR/exchange.env"
  cat >> "$PRIVATE_DIR/exchange.env" <<'ENV'
HOST=127.0.0.1
PORT=9003
DATA_DIR=/home/arbit/web/clicknlist.uk.to/private/exchange-data
OPERATOR_NAME=Kestrel
OLLAMA_URL=http://127.0.0.1:11434
# Optional, set only when you want paid API processing:
# OPENAI_API_KEY=
ENV
  chown arbit:arbit "$PRIVATE_DIR/exchange.env"
fi
chmod 600 "$PRIVATE_DIR/exchange.env"
install -d /etc/systemd/system/literatebassoon.service.d
cat > /etc/systemd/system/literatebassoon.service.d/environment.conf <<ENV
[Service]
EnvironmentFile=$PRIVATE_DIR/exchange.env
ENV
if [[ -f /etc/systemd/system/kestrel.service ]]; then cp -a /etc/systemd/system/kestrel.service "$PRIVATE_DIR/kestrel.service.$STAMP.bak"; fi
cp deploy/kestrel.service /etc/systemd/system/kestrel.service
cp -a "$CONF_DIR/nginx.conf" "$CONF_DIR/nginx.conf.$STAMP.bak"
cat > "$CONF_DIR/nginx.conf" <<'NGINX'
# HTTP redirect for the agent exchange. Keep the backup and use a custom Hestia
# template before rebuilding this domain, which otherwise overwrites this file.
server {
    listen 77.237.240.144:80;
    server_name clicknlist.uk.to;
    error_log /var/log/apache2/domains/clicknlist.uk.to.error.log error;
    location / { return 301 https://clicknlist.uk.to$request_uri; }
    # Preserve Hestia's certificate-validation snippets.
    include /home/arbit/conf/web/clicknlist.uk.to/nginx.conf_*;
}
NGINX
if ! nginx -t; then
  cp -a "$CONF_DIR/nginx.conf.$STAMP.bak" "$CONF_DIR/nginx.conf"
  echo 'Nginx validation failed; restored the previous HTTP configuration.'
  exit 1
fi
systemctl stop kestrel.service 2>/dev/null || true
systemctl daemon-reload
systemctl restart literatebassoon.service
for attempt in {1..20}; do
  if curl --fail --silent http://127.0.0.1:9003/api/health > /dev/null; then break; fi
  sleep 0.5
done
curl --fail --silent --show-error http://127.0.0.1:9003/api/health
systemctl enable --now kestrel.service
systemctl reload nginx
printf '\nUpdate complete. Admin: https://clicknlist.uk.to/admin\n'
printf 'The admin key is in %s/exchange.env. AI processing starts paused.\n' "$PRIVATE_DIR"
