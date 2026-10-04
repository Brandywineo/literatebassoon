import {mkdir,writeFile,readFile,lstat,chmod} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {freshWallet,describeWallet,encryptWallet,unlockWallet,outsideApplication} from '../src/hd-wallet.ts';
import {terminalPassword as password} from './terminal-password.ts';
async function main(){
 if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error('Run this wallet tool interactively in your own terminal');
 if(process.getuid?.()!==0)throw Error('Run as root: encrypted custody files must not be owned by the web app');
 const command=process.argv[2],dir=outsideApplication(resolve(process.argv[3]||'/var/lib/literatebassoon-wallet'));
 if(command==='init'){
  try{await lstat(dir);throw Error('Wallet directory already exists; use inspect. Never overwrite an existing wallet');}catch(e:any){if(e.code!=='ENOENT')throw e;}
  const first=await password('New wallet encryption password (at least 16 characters): '),second=await password('Repeat wallet password: ');if(first!==second)throw Error('Passwords did not match');
  const root=freshWallet(),encrypted=await encryptWallet(root.mnemonic!.phrase,first);
  await mkdir(dir,{mode:0o700});outsideApplication(realpathSync(dir));await chmod(dir,0o700);
  await writeFile(join(dir,'wallet.encrypted.json'),JSON.stringify(encrypted)+'\n',{mode:0o600,flag:'wx'});
  // Bootstrap recovery material is root-only and is never emitted into stdout/logs.
  await writeFile(join(dir,'recovery.txt'),root.mnemonic!.phrase+'\n',{mode:0o600,flag:'wx'});
  await writeFile(join(dir,'public.json'),JSON.stringify(describeWallet(root),null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log('Wallet created. Encrypted custody file: '+join(dir,'wallet.encrypted.json'));
  console.log('Recovery backup: '+join(dir,'recovery.txt')+' (copy offline, verify it, then remove this plaintext bootstrap file).');
  console.log('Public descriptor: '+join(dir,'public.json'));
  console.log('Treasury: '+describeWallet(root).hot_address+'\nGas wallet: '+describeWallet(root).gas_address);
 }else if(command==='inspect'){
  const directory=await lstat(dir);if(directory.uid!==0||(directory.mode&0o077)!==0)throw Error('Wallet directory must be root-owned with mode 0700');
  const encryptedFile=outsideApplication(realpathSync(join(dir,'wallet.encrypted.json'))),stat=await lstat(encryptedFile);if(stat.uid!==0||(stat.mode&0o077)!==0)throw Error('Encrypted wallet must be root-owned with mode 0600');
  const raw=await readFile(encryptedFile,'utf8');if(raw.length>8192)throw Error('Invalid encrypted wallet file');
  const root=await unlockWallet(JSON.parse(raw),await password('Wallet encryption password: ')),publicWallet=describeWallet(root);
  await writeFile(join(dir,'public.json'),JSON.stringify(publicWallet,null,2)+'\n',{mode:0o600});await chmod(join(dir,'public.json'),0o600);
  console.log('Public descriptor regenerated. Treasury: '+publicWallet.hot_address+'\nGas wallet: '+publicWallet.gas_address);
 }else throw Error('Use: node scripts/wallet-tool.ts init|inspect /var/lib/literatebassoon-wallet');
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Wallet operation failed');process.exitCode=1;});
