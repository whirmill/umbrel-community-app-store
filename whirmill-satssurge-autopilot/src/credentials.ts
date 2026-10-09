import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import type { Credential,CredentialStore } from '@earendil-works/pi-ai';
/** Only OAuth, isolated from tools and evidence. Process ownership protected by flock. */
export class Credentials implements CredentialStore {
  private db:DatabaseSync;private line=Promise.resolve();
  constructor(path:string){this.db=new DatabaseSync(path);this.db.exec('PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS credentials(provider TEXT PRIMARY KEY,content TEXT NOT NULL)');chmodSync(path,0o600);}
  async read(provider:string){const r=this.db.prepare('SELECT content FROM credentials WHERE provider=?').get(provider) as any;return r?JSON.parse(r.content) as Credential:undefined;}
  async list(){return this.db.prepare('SELECT provider,content FROM credentials').all().map((r:any)=>({providerId:r.provider,type:JSON.parse(r.content).type}));}
  async modify(provider:string,fn:(c:Credential|undefined)=>Promise<Credential|undefined>){
    let result:Credential|undefined;const run=this.line.then(async()=>{const current=await this.read(provider),next=await fn(current);if(next){if(next.type!=='oauth'||provider!=='openai')throw new Error('Subscription OAuth only');this.db.prepare('INSERT OR REPLACE INTO credentials VALUES(?,?)').run(provider,JSON.stringify(next));}result=next??current;});this.line=run.catch(()=>{});await run;return result;
  }
  async delete(provider:string){const run=this.line.then(()=>{this.db.prepare('DELETE FROM credentials WHERE provider=?').run(provider);});this.line=run.catch(()=>{});await run;}
  async close(){await this.line;this.db.close();}
}
