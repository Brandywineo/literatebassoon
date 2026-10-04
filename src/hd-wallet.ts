import {HDNodeWallet,HDNodeVoidWallet,Mnemonic} from 'ethers';
import {readFileSync,realpathSync} from 'node:fs';
import {createHash,randomBytes,createCipheriv,createDecipheriv,scrypt} from 'node:crypto';
import {promisify} from 'node:util';
import {dirname,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const kdf=promisify(scrypt);
export const accountPath="m/44'/60'/0'";
export type PublicWallet={version:1;chain_id:56;account_path:string;account_xpub:string;wallet_id:string;hot_address:string;gas_address:string};
export type EncryptedWallet={version:1;kdf:'scrypt';salt:string;iv:string;tag:string;ciphertext:string};
export function describeWallet(root:HDNodeWallet):PublicWallet {
 const account_xpub=root.neuter().extendedKey;
 return validatePublicWallet({version:1,chain_id:56,account_path:accountPath,account_xpub});
}
export function validatePublicWallet(raw:any):PublicWallet {
 if(raw&&Object.keys(raw).some(k=>/private|mnemonic|phrase|seed|password|cipher/i.test(k)))throw Error('Only public wallet metadata is permitted');
 if(!raw||raw.version!==1||raw.chain_id!==56||raw.account_path!==accountPath||typeof raw.account_xpub!=='string'||!raw.account_xpub.startsWith('xpub')||raw.account_xpub.length>120)throw Error('Invalid public wallet descriptor');
 let node:HDNodeVoidWallet;
 try{const n=HDNodeWallet.fromExtendedKey(raw.account_xpub);if(!(n instanceof HDNodeVoidWallet)||n.depth!==3||n.index!==0x80000000)throw Error();node=n;}catch{throw Error('Invalid public account key');}
 const result:PublicWallet={version:1,chain_id:56,account_path:accountPath,account_xpub:node.extendedKey,wallet_id:createHash('sha256').update(node.extendedKey).digest('hex'),hot_address:node.derivePath('1/0').address.toLowerCase(),gas_address:node.derivePath('1/1').address.toLowerCase()};
 for(const name of ['wallet_id','hot_address','gas_address'])if(raw[name]!=null&&raw[name]!==result[name as keyof PublicWallet])throw Error('Public wallet metadata mismatch');
 return result;
}
export function deriveDeposit(wallet:PublicWallet,index:number){if(!Number.isSafeInteger(index)||index<0||index>=0x80000000)throw Error('Deposit derivation index exhausted or invalid');return HDNodeWallet.fromExtendedKey(wallet.account_xpub).derivePath('0/'+index).address.toLowerCase();}
export function outsideApplication(path:string){const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),absolute=resolve(path),rel=relative(root,absolute);if(rel===''||(!rel.startsWith('..'+sep)&&rel!=='..'&&!rel.startsWith(sep))||absolute.split(sep).includes('public_html'))throw Error('Wallet files must be outside the application and public_html');return absolute;}
export function loadPublicWallet(path:string){const file=outsideApplication(realpathSync(path));if(readFileSync(file).length>8192)throw Error('Public wallet descriptor too large');return validatePublicWallet(JSON.parse(readFileSync(file,'utf8')));}
export function freshWallet(){return HDNodeWallet.fromPhrase(Mnemonic.fromEntropy(randomBytes(32)).phrase,undefined,accountPath);}
async function key(password:string,salt:Buffer){if(password.length<16||password.length>1024)throw Error('Wallet password must be 16–1024 characters');return await kdf(password,salt,32,{N:131072,r:8,p:1,maxmem:256*1024*1024}) as Buffer;}
export async function encryptWallet(phrase:string,password:string):Promise<EncryptedWallet>{const salt=randomBytes(16),iv=randomBytes(12),secret=await key(password,salt);try{const cipher=createCipheriv('aes-256-gcm',secret,iv);const ciphertext=Buffer.concat([cipher.update(phrase,'utf8'),cipher.final()]);return {version:1,kdf:'scrypt',salt:salt.toString('hex'),iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),ciphertext:ciphertext.toString('hex')};}finally{secret.fill(0);}}
export async function unlockWallet(raw:any,password:string){if(!raw||raw.version!==1||raw.kdf!=='scrypt'||! /^[a-f0-9]{32}$/.test(raw.salt)||! /^[a-f0-9]{24}$/.test(raw.iv)||! /^[a-f0-9]{32}$/.test(raw.tag)||typeof raw.ciphertext!=='string'||! /^[a-f0-9]{2,2048}$/.test(raw.ciphertext)||raw.ciphertext.length%2)throw Error('Invalid encrypted wallet file');const secret=await key(password,Buffer.from(raw.salt,'hex'));try{const decipher=createDecipheriv('aes-256-gcm',secret,Buffer.from(raw.iv,'hex'));decipher.setAuthTag(Buffer.from(raw.tag,'hex'));const plain=Buffer.concat([decipher.update(Buffer.from(raw.ciphertext,'hex')),decipher.final()]);try{return HDNodeWallet.fromPhrase(plain.toString('utf8'),undefined,accountPath);}finally{plain.fill(0);}}catch{throw Error('Wallet unlock failed');}finally{secret.fill(0);}}
