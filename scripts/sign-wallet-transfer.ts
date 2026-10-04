// Explicit root-only offline signer. It never opens a network connection or broadcasts.
import {readFile,writeFile,lstat} from 'node:fs/promises';
import {realpathSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {outsideApplication,unlockWallet} from '../src/hd-wallet.ts';
import {prepareTransfer,signWithJournal} from '../src/wallet-signing.ts';
import {terminalPassword} from './terminal-password.ts';
async function main(){
 if(process.getuid?.()!==0||!process.stdin.isTTY||!process.stdout.isTTY)throw Error('Run this isolated signer as root in your own interactive terminal');
 process.umask(0o077);
 const dir=outsideApplication(realpathSync(process.argv[2]||'/var/lib/literatebassoon-wallet')),requestFile=process.argv[3];if(!requestFile)throw Error('Use: node scripts/sign-wallet-transfer.ts VAULT_DIR REQUEST_JSON');
 const stats=await lstat(dir);if(stats.uid!==0||(stats.mode&0o077)!==0)throw Error('Wallet directory must be root-owned with mode 0700');
 const file=outsideApplication(realpathSync(join(dir,'wallet.encrypted.json'))),stat=await lstat(file);if(stat.uid!==0||(stat.mode&0o077)!==0)throw Error('Encrypted wallet must be root-owned with mode 0600');
 const encrypted=await readFile(file,'utf8'),requestText=await readFile(resolve(requestFile),'utf8');if(encrypted.length>8192||requestText.length>8192)throw Error('Wallet or request file too large');
 const root=await unlockWallet(JSON.parse(encrypted),await terminalPassword('Wallet encryption password: ')),prepared=prepareTransfer(root,JSON.parse(requestText));
 const journal=new DatabaseSync(join(dir,'signer.sqlite'));chmodSync(join(dir,'signer.sqlite'),0o600);
 try{const signed=await signWithJournal(journal,prepared);
  const output=join(dir,'signed-'+prepared.request.request_id+'.json');await writeFile(output,JSON.stringify(signed,null,2)+'\n',{mode:0o600});chmodSync(output,0o600);
  console.log('Signed transaction saved to '+output+'\nTransaction hash: '+signed.tx_hash+'\nNothing was broadcast.');
 }finally{journal.close();}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Signing failed');process.exitCode=1;});
