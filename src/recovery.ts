import {DatabaseSync,backup} from 'node:sqlite';
import {mkdirSync,chmodSync,existsSync,openSync,closeSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
// SQLite's online backup includes committed WAL data without stopping services.
// Verification never opens the backup through openStore (which runs migrations).
export async function backupDatabase(source:string,destination:string){
 source=resolve(source);destination=resolve(destination);
 if(source===destination||existsSync(destination))throw Error('Choose a new backup destination');
 mkdirSync(dirname(destination),{recursive:true,mode:0o700});
 const db=new DatabaseSync(source,{readOnly:true});try{closeSync(openSync(destination,'wx',0o600));await backup(db,destination);}finally{db.close();}
 chmodSync(destination,0o600);return verifyBackup(destination);
}
export function verifyBackup(path:string){
 const db=new DatabaseSync(resolve(path),{readOnly:true});try{
 const integrity=db.prepare('PRAGMA integrity_check').all();if(integrity.some(r=>r.integrity_check!=='ok'))throw Error('Backup integrity check failed');
 if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Backup foreign-key check failed');
 const counts:Record<string,number>={};for(const table of ['agents','jobs','ledger','kestrel_projects','kestrel_tasks','kestrel_experience','social_replies','social_generation'])if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))counts[table]=Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
 return {integrity:'ok',counts,limitations:'Database only. Keep private environment, Moltbook identity and encrypted wallet custody backups separately. Never run a restored copy alongside production.'};
 }finally{db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [action,source,destination]=process.argv.slice(2);
 if(action==='backup'&&source&&destination)backupDatabase(source,destination).then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error('Backup failed; verify paths and permissions');process.exitCode=1;});
 else if(action==='verify'&&source){try{console.log(JSON.stringify(verifyBackup(source)));}catch{console.error('Backup verification failed');process.exitCode=1;}}
 else{console.error('Usage: node src/recovery.ts backup SOURCE DESTINATION | verify BACKUP');process.exitCode=1;}
}
