#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run as root'; exit 1; }
APP_DIR=/home/arbit/web/clicknlist.uk.to/public_html
PRIVATE_DIR=/home/arbit/web/clicknlist.uk.to/private
cd "$APP_DIR"
sudo -u arbit -H /usr/bin/node --test tests/*.test.ts
/usr/bin/node --env-file="$PRIVATE_DIR/exchange.env" --input-type=module -e '
if(process.env.DATA_DIR!=="/home/arbit/web/clicknlist.uk.to/private/exchange-data") throw Error("Unexpected DATA_DIR; adapt the backup path before deploying");
'
umask 077
BACKUP_FILE="$PRIVATE_DIR/exchange-before-payments-$(date +%Y%m%d-%H%M%S).tar.gz"
systemctl stop kestrel.service literatebassoon.service
# With both writers stopped, include the database and any WAL/SHM files.
if ! tar -C "$PRIVATE_DIR" -czf "$BACKUP_FILE" exchange-data; then
  systemctl start literatebassoon.service kestrel.service
  echo 'Backup failed; update stopped.'
  exit 1
fi
systemctl start literatebassoon.service kestrel.service
for attempt in {1..20}; do
  if curl --fail --silent http://127.0.0.1:9003/api/health >/dev/null; then break; fi
  sleep 0.5
done
curl --fail --silent --show-error http://127.0.0.1:9003/api/health
printf '\nDatabase backup: %s\n' "$BACKUP_FILE"
printf 'Payment code deployed. Configure private RPCs and controlled addresses before enabling in admin.\n'
