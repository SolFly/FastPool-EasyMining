import { DatabaseSync } from 'node:sqlite';
import {mkdirSync,readFileSync,writeFileSync,existsSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {DEFAULTS} from '../public/core.mjs';

export class Store {
  constructor(dir){
    mkdirSync(dir,{recursive:true,mode:0o700});
    const keyPath=join(dir,'master.key');
    if(!existsSync(keyPath))writeFileSync(keyPath,randomBytes(32),{mode:0o600,flag:'wx'});
    this.key=readFileSync(keyPath);if(this.key.length!==32)throw new Error('Invalid master.key');
    this.db=new DatabaseSync(join(dir,'controller.sqlite'));chmodSync(join(dir,'controller.sqlite'),0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS strategies (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, external_id TEXT, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS orders_external ON orders(external_id) WHERE external_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS rewards (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, until_ms INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO lease(id) VALUES (1);`);
    if(!this.get('settings'))this.set('settings',DEFAULTS);
    const s=this.get('settings');s.running=false;s.liveArmed=false;this.set('settings',s);
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    for(const o of this.orders())if(o.status==='SUBMITTING'){o.status='UNKNOWN';this.saveOrder(o);}
  }
  get(k){const r=this.db.prepare('SELECT value FROM kv WHERE key=?').get(k);return r?JSON.parse(r.value):null;}
  set(k,v){this.db.prepare('INSERT INTO kv(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,JSON.stringify(v));}
  list(table){if(!['strategies','orders','rewards'].includes(table))throw new Error('Bad table');return this.db.prepare(`SELECT data FROM ${table}`).all().map(r=>JSON.parse(r.data));}
  strategies(){return this.list('strategies');}
  orders(){return this.list('orders').sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));}
  rewards(){return this.list('rewards');}
  strategy(s){this.db.prepare('INSERT INTO strategies(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(s.id,JSON.stringify(s));}
  saveOrder(o){this.db.prepare('INSERT INTO orders(id,external_id,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET external_id=excluded.external_id,data=excluded.data').run(o.id,o.externalId||null,JSON.stringify(o));}
  reward(r){this.db.prepare('INSERT INTO rewards(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(r.id,JSON.stringify(r));}
  event(level,message){this.db.prepare('INSERT INTO events(at,level,message) VALUES (?,?,?)').run(new Date().toISOString(),level,String(message).slice(0,700));}
  events(){return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 300').all();}
  seal(value){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv);const data=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),data]).toString('base64');}
  unseal(value){const b=Buffer.from(value,'base64'),d=createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());}
  credentials(){const v=this.get('credentials');return v?this.unseal(v):null;}
  saveCredentials(v){this.set('credentials',this.seal(v));}
  state(){return {settings:this.get('settings'),strategies:this.strategies(),orders:this.orders(),rewards:this.rewards(),
    packages:this.get('packages')||[],events:this.events(),runtime:this.get('runtime')||{},
    connection:{configured:!!this.get('credentials'),verified:!!this.get('verified'),organizationId:this.get('organizationId')||''}};}
  acquire(owner){return !!this.db.prepare('UPDATE lease SET owner=?,until_ms=? WHERE id=1 AND until_ms < ? RETURNING id').get(owner,Date.now()+180000,Date.now());}
  renew(owner){return !!this.db.prepare('UPDATE lease SET until_ms=? WHERE id=1 AND owner=? RETURNING id').get(Date.now()+180000,owner);}
  owns(owner){return !!this.db.prepare('SELECT id FROM lease WHERE id=1 AND owner=? AND until_ms>?').get(owner,Date.now());}
  release(owner){this.db.prepare('UPDATE lease SET until_ms=0,owner=NULL WHERE id=1 AND owner=?').run(owner);}
  close(){this.db.close();}
}
