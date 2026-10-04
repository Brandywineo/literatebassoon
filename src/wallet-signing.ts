import {Interface,Transaction,HDNodeWallet} from 'ethers';
import {createHash} from 'node:crypto';
const token='0x55d398326f99059ff775485246999027b3197955';
const erc20=new Interface(['function transfer(address,uint256) returns (bool)']);
function numberString(value:unknown){if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,59})$/.test(value))throw Error('Transaction amounts must be unsigned atomic-unit strings');return BigInt(value);}
export function prepareTransfer(root:HDNodeWallet,raw:any){
 if(!raw||typeof raw.request_id!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(raw.request_id)||!['hot','gas'].includes(raw.role)||!['USDT','BNB'].includes(raw.asset)||raw.chain_id!==56)throw Error('Invalid transfer request');
 if(raw.role==='gas'&&raw.asset!=='BNB')throw Error('Gas wallet can sign only native BNB transfers');
 if(typeof raw.to!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(raw.to)||/^0x0{40}$/i.test(raw.to))throw Error('Invalid destination');
 if(!Number.isSafeInteger(raw.nonce)||raw.nonce<0)throw Error('Set an explicit valid nonce');
 const amount=numberString(raw.amount),gasPrice=numberString(raw.gas_price),gasLimit=numberString(raw.gas_limit);if(amount===0n||gasPrice===0n||gasLimit<21000n||gasLimit>500000n)throw Error('Invalid amount or gas settings');
 const signer=root.derivePath(raw.role==='hot'?'1/0':'1/1');
 const request={request_id:raw.request_id,chain_id:56,role:raw.role,asset:raw.asset,to:raw.to.toLowerCase(),amount:amount.toString(),nonce:raw.nonce,gas_price:gasPrice.toString(),gas_limit:gasLimit.toString()};
 const tx={type:0,chainId:56,nonce:raw.nonce,gasPrice,gasLimit,to:raw.asset==='USDT'?token:request.to,value:raw.asset==='BNB'?amount:0n,data:raw.asset==='USDT'?erc20.encodeFunctionData('transfer',[request.to,amount]):'0x'};
 return {request,signer,tx,fingerprint:createHash('sha256').update(JSON.stringify(request)).digest('hex')};
}
export async function signPrepared(prepared:ReturnType<typeof prepareTransfer>){const raw=await prepared.signer.signTransaction(prepared.tx),tx=Transaction.from(raw);return {request:prepared.request,from:prepared.signer.address.toLowerCase(),tx_hash:tx.hash!,raw_transaction:raw};}

export async function signWithJournal(journal:any,prepared:ReturnType<typeof prepareTransfer>){
 journal.exec(`PRAGMA busy_timeout=5000;CREATE TABLE IF NOT EXISTS signatures(request_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,sender TEXT NOT NULL,nonce INTEGER NOT NULL,result TEXT NOT NULL,UNIQUE(sender,nonce));`);
 journal.exec('BEGIN IMMEDIATE');
 try{
  const previous=journal.prepare('SELECT fingerprint,result FROM signatures WHERE request_id=?').get(prepared.request.request_id);
  let signed:any;
  if(previous){if(previous.fingerprint!==prepared.fingerprint)throw Error('Request ID already signed with different transaction fields');signed=JSON.parse(String(previous.result));}
  else{if(journal.prepare('SELECT request_id FROM signatures WHERE sender=? AND nonce=?').get(prepared.signer.address.toLowerCase(),prepared.request.nonce))throw Error('Nonce already reserved by another signed request');signed=await signPrepared(prepared);journal.prepare('INSERT INTO signatures(request_id,fingerprint,sender,nonce,result) VALUES(?,?,?,?,?)').run(prepared.request.request_id,prepared.fingerprint,signed.from,prepared.request.nonce,JSON.stringify(signed));}
  journal.exec('COMMIT');return signed;
 }catch(e){journal.exec('ROLLBACK');throw e;}
}
