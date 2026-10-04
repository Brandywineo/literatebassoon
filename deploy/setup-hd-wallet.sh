#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run as root'; exit 1; }
[[ -t 0 && -t 1 ]] || { echo 'Run in your own interactive SSH terminal'; exit 1; }
APP_DIR=/home/arbit/web/clicknlist.uk.to/public_html
PRIVATE_DIR=/home/arbit/web/clicknlist.uk.to/private
VAULT_DIR=/var/lib/literatebassoon-wallet
cd "$APP_DIR"
[[ -f "$PRIVATE_DIR/exchange.env" ]] || { echo 'Existing exchange.env is required'; exit 1; }
[[ -d node_modules/ethers ]] || { echo 'Run deploy/update-payments.sh first to install dependencies'; exit 1; }
if [[ -f "$VAULT_DIR/wallet.encrypted.json" ]]; then
  /usr/bin/node scripts/wallet-tool.ts inspect "$VAULT_DIR"
else
  /usr/bin/node scripts/wallet-tool.ts init "$VAULT_DIR"
fi
# Validate the public manifest before copying it into the web user's private area.
/usr/bin/node --input-type=module <<'JS'
import {loadPublicWallet} from './src/hd-wallet.ts';
import {existsSync,readFileSync} from 'node:fs';
const fresh=loadPublicWallet('/var/lib/literatebassoon-wallet/public.json');
const target='/home/arbit/web/clicknlist.uk.to/private/wallet-public.json';
if(existsSync(target)&&loadPublicWallet(target).wallet_id!==fresh.wallet_id)throw Error('Wallet ID differs from the existing public descriptor; do not replace it without a reviewed rotation');
const env=readFileSync('/home/arbit/web/clicknlist.uk.to/private/exchange.env','utf8');
const matches=env.split('\n').filter(row=>/^\s*BASSOON_WALLET_PUBLIC_FILE=/.test(row));
if(matches.length>1)throw Error('Duplicate HD descriptor configuration');
if(matches.length){const value=matches[0].slice(matches[0].indexOf('=')+1).trim().replace(/^['"]|['"]$/g,'');if(value&&value!==target)throw Error('Existing HD descriptor path differs; review before changing it');}
JS
install -o arbit -g arbit -m 600 "$VAULT_DIR/public.json" "$PRIVATE_DIR/wallet-public.json"
/usr/bin/node --input-type=module <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
const file='/home/arbit/web/clicknlist.uk.to/private/exchange.env';
const path='/home/arbit/web/clicknlist.uk.to/private/wallet-public.json';
let env=readFileSync(file,'utf8');
const rows=env.split('\n');
const matches=rows.map((row,i)=>({row,i})).filter(x=>/^\s*BASSOON_WALLET_PUBLIC_FILE=/.test(x.row));
if(matches.length>1)throw Error('Duplicate BASSOON_WALLET_PUBLIC_FILE entries; reconcile them before activation');
if(matches.length){const m=matches[0],value=m.row.slice(m.row.indexOf('=')+1).trim().replace(/^['"]|['"]$/g,'');if(value&&value!==path)throw Error('Different HD wallet configuration exists; pause payments and review before changing it');rows[m.i]='BASSOON_WALLET_PUBLIC_FILE='+path;env=rows.join('\n');}
else env=env.trimEnd()+'\nBASSOON_WALLET_PUBLIC_FILE='+path+'\n';
writeFileSync(file,env,{mode:0o600});
JS
chown arbit:arbit "$PRIVATE_DIR/exchange.env"
chmod 600 "$PRIVATE_DIR/exchange.env"
systemctl restart literatebassoon.service kestrel.service
for attempt in {1..20}; do
  if curl --fail --silent http://127.0.0.1:9003/api/health >/dev/null; then break; fi
  sleep 0.5
done
curl --fail --silent --show-error http://127.0.0.1:9003/api/health
printf '\nHD wallet configured. Payment enablement and RPC settings were not changed.\n'
printf 'Root-only custody: %s\nPublic-only descriptor: %s/wallet-public.json\n' "$VAULT_DIR" "$PRIVATE_DIR"
printf 'Back up the recovery phrase OFFLINE and verify it before funding any address. Never paste recovery material into chat.\n'
