import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HDNodeWallet,Transaction,Interface} from 'ethers';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {openStore} from '../src/store.ts';
import {openPayments} from '../src/payments.ts';
import {accountPath,describeWallet,validatePublicWallet,deriveDeposit,encryptWallet,unlockWallet,outsideApplication} from '../src/hd-wallet.ts';
import {prepareTransfer,signPrepared} from '../src/wallet-signing.ts';
// Public test vector only: never use this mnemonic for actual funds.
const phrase='test test test test test test test test test test test junk';
const root=HDNodeWallet.fromPhrase(phrase,undefined,accountPath),descriptor=describeWallet(root);
function fixture(){const dir=mkdtempSync(tmpdir()+'/bassoon-hd-'),file=dir+'/wallet-public.json',store=openStore(dir+'/data');writeFileSync(file,JSON.stringify(descriptor),{mode:0o600});const env:any={PAYMENTS_ALLOW_LIVE:'1',BASSOON_WALLET_PUBLIC_FILE:file};return {dir,file,store,env,close(){store.db.close();rmSync(dir,{recursive:true,force:true});}};}
test('public-only descriptor derives matching private-wallet addresses and rejects private/wrong-branch metadata',()=>{
 assert.ok(descriptor.account_xpub.startsWith('xpub'));assert.ok(!JSON.stringify(descriptor).includes(phrase));
 for(const i of [0,1,99,10000])assert.equal(deriveDeposit(descriptor,i),root.derivePath('0/'+i).address.toLowerCase());
 assert.equal(descriptor.hot_address,root.derivePath('1/0').address.toLowerCase());assert.equal(descriptor.gas_address,root.derivePath('1/1').address.toLowerCase());
 assert.throws(()=>validatePublicWallet({...descriptor,account_xpub:root.extendedKey}),/public wallet/);
 assert.throws(()=>validatePublicWallet({...descriptor,account_xpub:root.deriveChild(0).neuter().extendedKey}),/public account/);
 assert.throws(()=>validatePublicWallet({...descriptor,privateKey:'not-allowed'}),/Only public/);
 assert.throws(()=>validatePublicWallet({...descriptor,chain_id:1}),/descriptor/);
 assert.throws(()=>validatePublicWallet({...descriptor,hot_address:'0x'+'1'.repeat(40)}),/mismatch/);
 assert.throws(()=>deriveDeposit(descriptor,0x80000000),/index/);assert.throws(()=>deriveDeposit(descriptor,-1),/index/);
 assert.throws(()=>outsideApplication(process.cwd()+'/data/wallet.json'),/outside/);
 assert.throws(()=>outsideApplication('/home/arbit/web/clicknlist.uk.to/public_html/wallet.json'),/outside/);
});
test('encrypted wallet authenticates password and ciphertext without storing clear recovery material',async()=>{
 const password='known-test-only-password-for-encryption',encrypted=await encryptWallet(phrase,password);
 assert.ok(!JSON.stringify(encrypted).includes(phrase));assert.ok(!JSON.stringify(encrypted).includes(password));
 assert.equal((await unlockWallet(encrypted,password)).address,root.address);
 await assert.rejects(unlockWallet(encrypted,'wrong-test-password'),/unlock failed/);
 const altered={...encrypted,ciphertext:(encrypted.ciphertext.startsWith('00')?'01':'00')+encrypted.ciphertext.slice(2)};
 await assert.rejects(unlockWallet(altered,password),/unlock failed/);await assert.rejects(encryptWallet(phrase,'short'),/16/);
});
test('HD allocation persists per-agent ownership and serial counter across two stores and restarts',()=>{
 const f=fixture();let second:any;try{const p=openPayments(f.store,f.env);f.store.db.prepare('UPDATE money_settings SET enabled=1').run();const a=f.store.register('hd-agent-a','agent'),b=f.store.register('hd-agent-b','agent');second=openStore(f.dir+'/data');const p2=openPayments(second,f.env);
 assert.equal(p.depositAddress(a.id).address,deriveDeposit(descriptor,0));assert.equal(p2.depositAddress(b.id).address,deriveDeposit(descriptor,1));assert.equal(p2.depositAddress(a.id).address,deriveDeposit(descriptor,0));assert.equal(p.overview().hd_wallet.next_index,2);
 second.db.close();second=openStore(f.dir+'/data');const reopened=openPayments(second,{PAYMENTS_ALLOW_LIVE:'1'} as any);assert.equal(reopened.depositAddress(a.id).address,deriveDeposit(descriptor,0));assert.equal(reopened.overview().hd_wallet.next_index,2);assert.equal(reopened.overview().hd_wallet.hot_address,descriptor.hot_address);assert.ok(!JSON.stringify(reopened.overview()).includes('xpub'));
 }finally{second?.db.close();f.close();}
});
test('existing manual assignments stay unchanged and failed derived-address collision rolls back index',()=>{
 const f=fixture();try{const a=f.store.register('old-agent','agent'),b=f.store.register('new-agent','agent'),old='0x'+'1'.repeat(40);f.store.db.prepare('INSERT INTO money_addresses(address,agent_id,assigned_ms) VALUES(?,?,?)').run(old,a.id,Date.now());const p=openPayments(f.store,f.env);f.store.db.prepare('UPDATE money_settings SET enabled=1').run();assert.equal(p.depositAddress(a.id).address,old);
 f.store.db.prepare('INSERT INTO money_addresses(address) VALUES(?)').run(deriveDeposit(descriptor,0));assert.throws(()=>p.depositAddress(b.id),/already exists/);assert.equal(p.overview().hd_wallet.next_index,0);assert.equal(p.wallet(b.id).deposit_address,null);
 }finally{f.close();}
});
test('HD wallet changes require paused payments, and switching back retains the previous index',()=>{
 const f=fixture();try{const p=openPayments(f.store,f.env),a=f.store.register('rotation-agent','agent');f.store.db.prepare('UPDATE money_settings SET enabled=1').run();p.depositAddress(a.id);const other=describeWallet(HDNodeWallet.fromPhrase('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',undefined,accountPath));writeFileSync(f.file,JSON.stringify(other));assert.throws(()=>openPayments(f.store,f.env),/Pause payments/);f.store.db.prepare('UPDATE money_settings SET enabled=0').run();assert.equal(openPayments(f.store,f.env).overview().hd_wallet.wallet_id,other.wallet_id);writeFileSync(f.file,JSON.stringify(descriptor));assert.equal(openPayments(f.store,f.env).overview().hd_wallet.next_index,1);assert.equal(p.wallet(a.id).deposit_address,deriveDeposit(descriptor,0));
 }finally{f.close();}
});
test('isolated offline signing fixes chain, token and roles and produces recoverable exact transfer signatures',async()=>{
 const request={request_id:'withdrawal-test-1',chain_id:56,role:'hot',asset:'USDT',to:'0x'+'1'.repeat(40),amount:'1000000000000000000',nonce:0,gas_price:'1000000000',gas_limit:'100000'};
 const prepared=prepareTransfer(root,request),signed=await signPrepared(prepared),tx=Transaction.from(signed.raw_transaction);assert.equal(tx.chainId,56n);assert.equal(tx.from?.toLowerCase(),descriptor.hot_address);assert.equal(tx.to?.toLowerCase(),'0x55d398326f99059ff775485246999027b3197955');assert.equal(tx.value,0n);const decoded=new Interface(['function transfer(address,uint256)']).decodeFunctionData('transfer',tx.data);assert.equal(decoded[0].toLowerCase(),request.to);assert.equal(decoded[1],1000000000000000000n);
 const bnb=await signPrepared(prepareTransfer(root,{...request,request_id:'gas-test-1',role:'gas',asset:'BNB',nonce:1,gas_limit:'21000'}));assert.equal(Transaction.from(bnb.raw_transaction).from?.toLowerCase(),descriptor.gas_address);assert.equal(Transaction.from(bnb.raw_transaction).value,1000000000000000000n);
 assert.throws(()=>prepareTransfer(root,{...request,chain_id:1}),/Invalid/);assert.throws(()=>prepareTransfer(root,{...request,role:'gas'}),/native BNB/);assert.throws(()=>prepareTransfer(root,{...request,nonce:-1}),/nonce/);
});
test('wallet creation and offline signer refuse noninteractive execution before writing custody files',()=>{
 for(const script of ['scripts/wallet-tool.ts','scripts/sign-wallet-transfer.ts']){const r=spawnSync(process.execPath,[script,'init','/tmp/must-not-create-bassoon-test'],{encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/interactive/);assert.ok(!r.stdout.includes('Recovery'));}
});

test('offline signer journal reuses exact signatures and forbids changed requests or nonce reuse',async()=>{
 const {DatabaseSync}=await import('node:sqlite'),{signWithJournal}=await import('../src/wallet-signing.ts');const db=new DatabaseSync(':memory:');try{const req={request_id:'journal-request1',chain_id:56,role:'hot',asset:'BNB',to:'0x'+'1'.repeat(40),amount:'1',nonce:0,gas_price:'1000000000',gas_limit:'21000'},prepared=prepareTransfer(root,req);const first=await signWithJournal(db,prepared),again=await signWithJournal(db,prepared);assert.equal(first.raw_transaction,again.raw_transaction);await assert.rejects(signWithJournal(db,prepareTransfer(root,{...req,amount:'2'})),/different/);await assert.rejects(signWithJournal(db,prepareTransfer(root,{...req,request_id:'journal-request2'})),/Nonce/);assert.equal(db.prepare('SELECT count(*) AS n FROM signatures').get()?.n,1);}finally{db.close();}
});

test('simultaneous allocator processes receive distinct persisted derivation indexes',async()=>{
 const {Worker}=await import('node:worker_threads');const f=fixture();const workers:any[]=[];
 try{openPayments(f.store,f.env);f.store.db.prepare('UPDATE money_settings SET enabled=1').run();const owners=[f.store.register('parallel-agent-a','agent').id,f.store.register('parallel-agent-b','agent').id];
 const code=`const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {openStore}=await import(workerData.storeModule),{openPayments}=await import(workerData.paymentModule);const store=openStore(workerData.dir),payments=openPayments(store,workerData.env);parentPort.on('message',()=>{try{const result=payments.depositAddress(workerData.owner);parentPort.postMessage({address:result.address});}catch(e){parentPort.postMessage({error:e.message});}finally{store.db.close();parentPort.close();}});parentPort.postMessage({ready:true});})().catch(e=>{parentPort.postMessage({error:e.message});parentPort.close();});`;
 for(const owner of owners)workers.push(new Worker(code,{eval:true,workerData:{owner,dir:f.dir+'/data',env:f.env,storeModule:new URL('../src/store.ts',import.meta.url).href,paymentModule:new URL('../src/payments.ts',import.meta.url).href}}));
 await Promise.all(workers.map(w=>new Promise<void>((resolve,reject)=>{w.once('error',reject);w.once('message',m=>m.ready?resolve():reject(Error(m.error||'Worker initialization failed')));})));const results=workers.map(w=>new Promise<any>((resolve,reject)=>{w.once('error',reject);w.once('message',resolve);}));for(const w of workers)w.postMessage('allocate');const allocated=await Promise.all(results);assert.ok(allocated.every(r=>r.address),JSON.stringify(allocated));assert.deepEqual(new Set(allocated.map(r=>r.address)),new Set([deriveDeposit(descriptor,0),deriveDeposit(descriptor,1)]));assert.equal(f.store.db.prepare('SELECT next_index FROM money_hd_wallets WHERE active=1').get()?.next_index,2);
 }finally{await Promise.all(workers.map(w=>w.terminate()));f.close();}
});
