import type {DatabaseSync} from 'node:sqlite';
import {loadPublicWallet,validatePublicWallet,deriveDeposit} from './hd-wallet.ts';
export function initHD(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS money_hd_wallets(wallet_id TEXT PRIMARY KEY,account_xpub TEXT UNIQUE NOT NULL,hot_address TEXT NOT NULL,gas_address TEXT NOT NULL,next_index INTEGER NOT NULL DEFAULT 0 CHECK(next_index>=0 AND next_index<=2147483648),active INTEGER NOT NULL DEFAULT 0);
 CREATE UNIQUE INDEX IF NOT EXISTS money_hd_active ON money_hd_wallets(active) WHERE active=1;`);
 for(const [name,definition] of [['wallet_id','TEXT'],['derivation_index','INTEGER']])if(!db.prepare('PRAGMA table_info(money_addresses)').all().some(c=>c.name===name))db.exec(`ALTER TABLE money_addresses ADD COLUMN ${name} ${definition}`);
 db.exec('CREATE UNIQUE INDEX IF NOT EXISTS money_hd_address_index ON money_addresses(wallet_id,derivation_index) WHERE wallet_id IS NOT NULL');
}
export function configureHD(store:any,file?:string){
 if(file){const wallet=loadPublicWallet(file);store.transaction(()=>{
 const active=store.db.prepare('SELECT wallet_id FROM money_hd_wallets WHERE active=1').get();
 if(active&&active.wallet_id!==wallet.wallet_id&&store.db.prepare('SELECT enabled FROM money_settings WHERE id=1').get()?.enabled)throw Error('Pause payments before changing the HD wallet');
 store.db.prepare('INSERT OR IGNORE INTO money_hd_wallets(wallet_id,account_xpub,hot_address,gas_address) VALUES(?,?,?,?)').run(wallet.wallet_id,wallet.account_xpub,wallet.hot_address,wallet.gas_address);
 store.db.prepare('UPDATE money_hd_wallets SET active=0 WHERE active=1 AND wallet_id<>?').run(wallet.wallet_id);
 store.db.prepare('UPDATE money_hd_wallets SET active=1 WHERE wallet_id=?').run(wallet.wallet_id);
 for(const addr of [wallet.hot_address,wallet.gas_address])store.db.prepare('INSERT OR IGNORE INTO money_treasury(address) VALUES(?)').run(addr);
 if(!active||active.wallet_id!==wallet.wallet_id)store.audit('hd_wallet_configured',wallet.wallet_id);
 });}
 return {
  status(){const row=store.db.prepare('SELECT wallet_id,hot_address,gas_address,next_index FROM money_hd_wallets WHERE active=1').get();return row?{configured:true,...row}:{configured:false};},
  // Called inside the caller's BEGIN IMMEDIATE: counter and ownership commit together.
  allocate(owner:string){const row=store.db.prepare('SELECT * FROM money_hd_wallets WHERE active=1').get();if(!row)return undefined;
   const index=Number(row.next_index),wallet=validatePublicWallet({version:1,chain_id:56,account_path:"m/44'/60'/0'",...row}),address=deriveDeposit(wallet,index);
   if(store.db.prepare('SELECT address FROM money_addresses WHERE address=?').get(address))throw Error('Derived address already exists; reconcile the wallet index before assigning');
   store.db.prepare('INSERT INTO money_addresses(address,agent_id,assigned_ms,wallet_id,derivation_index) VALUES(?,?,?,?,?)').run(address,owner,Date.now(),wallet.wallet_id,index);
   store.db.prepare('UPDATE money_hd_wallets SET next_index=next_index+1 WHERE wallet_id=?').run(wallet.wallet_id);
   return {address};
  }
 };
}
