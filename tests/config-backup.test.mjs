import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {restoreConfiguration} from '../server/config-backup.mjs';
import {configurationBackup,parseConfigurationBackup,prepareConfigurationImport} from '../public/config-backup.mjs';
import {DEFAULTS,STRATEGY_DEFAULTS,guard} from '../public/core.mjs';
import {DemoApi} from '../public/demo.mjs';

const stamp='2026-10-26T12:00:00.000Z';
const strategy=extra=>({...STRATEGY_DEFAULTS,id:'s',name:'My shares',enabled:true,payoutAddress:'bc1qexampledestination0000000000000000000',mergePayoutAddress:'DExampleMergedDestination0000000000000',createdAt:'2026-10-01T10:00:00.000Z',...extra});
const state=()=>({settings:{...DEFAULTS,mode:'live',running:true,liveArmed:true,accountSyncSeconds:95,autoSync:false,displayCurrency:'EUR'},strategies:[strategy()],orders:[],rewards:[]});
const options={idFactory:()=> 'new-strategy',now:stamp};
function setup(t){const dir=mkdtempSync(join(tmpdir(),'fp-import-'));const store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,engine:{store,busy:false}};}

test('compact settings export and old full JSON restore every configurable field, paused',()=>{
  const source=state(),compact=configurationBackup({...source,connection:{secret:'must-not-export'},runtime:{errors:5}});
  assert.equal(compact.settings.running,false);assert.equal(compact.settings.liveArmed,false);
  assert.equal(compact.connection,undefined);assert.equal(compact.runtime,undefined);assert.equal(compact.orders,undefined);
  for(const backup of [compact,{version:'1.0.0',exportedAt:stamp,...source}]){
    const plan=prepareConfigurationImport(backup,{settings:DEFAULTS,strategies:[],orders:[]},options);
    assert.deepEqual(plan.settings,{...source.settings,running:false,liveArmed:false});
    assert.deepEqual(plan.strategies[0],{...source.strategies[0],enabled:false,lastBuyAt:null});
  }
});

test('older exports receive new defaults and source fields never import secrets or spending authority',()=>{
  const old={...DEFAULTS};delete old.autoSync;delete old.accountSyncSeconds;
  const plan=prepareConfigurationImport({settings:{...old,liveArmed:true,running:true,credentials:{key:'ignored'},unexpected:'ignored'},strategies:[strategy({extra:'ignored'})]},state(),options);
  assert.equal(plan.settings.autoSync,true);assert.equal(plan.settings.accountSyncSeconds,60);assert.equal(plan.settings.credentials,undefined);assert.equal(plan.settings.unexpected,undefined);assert.equal(plan.strategies[0].extra,undefined);
  assert.equal(plan.settings.running,false);assert.equal(plan.settings.liveArmed,false);
});

test('repeat imports update matching IDs and keep budget, purchase counts, payout addresses and later cooldown',()=>{
  const current=state();current.strategies[0].lastBuyAt='2026-10-26T11:30:00Z';
  current.orders=[{id:'purchase',strategyId:'s',mode:'live',status:'COMPLETED',costBtc:10000,createdAt:stamp}];
  const backup={strategies:[strategy({continuous:false,lastBuyAt:'2026-10-25T00:00:00Z',maxPurchases:1})]};
  const first=prepareConfigurationImport(backup,current,{...options,restoreSettings:false});
  const second=prepareConfigurationImport(backup,{...current,...first},{...options,restoreSettings:false});
  assert.equal(second.strategies.length,1);assert.equal(second.strategies[0].id,'s');assert.equal(second.strategies[0].lastBuyAt,stamp);
  assert.equal(second.strategies[0].payoutAddress,backup.strategies[0].payoutAddress);
  const funded={...current,settings:{...second.settings,running:true,liveArmed:true},strategies:second.strategies,runtime:{lastSync:stamp,balance:10000000,historyComplete:true}};
  assert.equal(guard(funded,{...second.strategies[0],enabled:true},{id:'p',market:'BTC',costBtc:10000,available:true,quotedAt:stamp},Date.parse(stamp)),'Purchase count reached');
});

test('settings-only, strategies-only, merge and replacement have distinct effects',()=>{
  const current=state();current.strategies.push(strategy({id:'keep',name:'Keep me'}));
  const settings=prepareConfigurationImport({settings:{...DEFAULTS,reserve:123456}},current,{...options,restoreStrategies:false});
  assert.equal(settings.settings.reserve,123456);assert.deepEqual(settings.strategies,current.strategies);
  const b={strategies:[strategy({id:'s',name:'Restored'}),strategy({id:'new',name:'New'})]};
  const merge=prepareConfigurationImport(b,current,{...options,restoreSettings:false});
  assert.deepEqual(merge.strategies.map(s=>s.id),['keep','s','new']);assert.equal(merge.settings.accountSyncSeconds,95);assert.equal(merge.settings.running,false);
  const replace=prepareConfigurationImport(b,current,{...options,restoreSettings:false,strategyMode:'replace'});
  assert.deepEqual(replace.strategies.map(s=>s.id),['s','new']);
  const empty=prepareConfigurationImport({strategies:[]},current,{...options,restoreSettings:false,strategyMode:'replace'});assert.deepEqual(empty.strategies,[]);
});

test('invalid files, settings, strategies, duplicate IDs and future format fail before any write',()=>{
  for(const bad of [null,[],{}, {orders:[]},{settings:{}},{settings:{dailyCap:-1}},{settings:{reserve:'1'}},{settings:{autoSync:'false'}},{settings:{displayCurrency:'DOGE'}},{settings:{timezone:'bad/timezone'}},{kind:'fastpool-easymining-settings',schemaVersion:2,settings:DEFAULTS},{strategies:[strategy(),strategy()]},{strategies:[strategy({enabled:'false'})]},{strategies:[strategy({days:[7]})]},{strategies:[strategy({lastBuyAt:'invalid'})]},{strategies:[null]},{strategies:Array(1001).fill(strategy())}])assert.throws(()=>parseConfigurationBackup(bad));
  assert.throws(()=>prepareConfigurationImport(state(),state(),{...options,restoreSettings:false,restoreStrategies:false}),/Select/);
  assert.throws(()=>prepareConfigurationImport(state(),state(),{...options,restoreSettings:'yes'}),/Choose/);
  assert.throws(()=>prepareConfigurationImport(state(),state(),{...options,strategyMode:'other'}),/valid/);
});

test('invalid import and database failure roll back configuration, buying state and quote invalidation',t=>{
  const {store,engine}=setup(t);store.set('settings',state().settings);store.strategy(strategy());store.set('purchase-quote:open',{id:'open'});
  assert.throws(()=>restoreConfiguration(engine,{settings:DEFAULTS,strategies:[strategy({budget:0})]}));
  assert.equal(store.get('settings').running,true);assert.equal(store.strategies()[0].enabled,true);
  store.db.exec("CREATE TRIGGER fail_strategy BEFORE INSERT ON strategies BEGIN SELECT RAISE(ABORT,'simulated write failure'); END");
  assert.throws(()=>restoreConfiguration(engine,{settings:DEFAULTS,strategies:[strategy({name:'New name'})]}),/simulated/);
  assert.equal(store.get('settings').running,true);assert.equal(store.strategies()[0].name,'My shares');assert.ok(store.get('purchase-quote:open'));assert.equal(store.events().length,0);assert.equal(engine.busy,false);
});

test('successful import retains live ledger, unknown reservations, encrypted credentials and sessions',t=>{
  const {store,engine}=setup(t);store.set('settings',state().settings);store.strategy(strategy());
  store.saveCredentials({key:'saved-key',secret:'saved-secret',orgId:'mine'});store.set('credentialSource','web');store.set('verified',true);store.set('ledgerOrgId','mine');
  const order={id:'uncertain',externalId:'nh-id',strategyId:'s',mode:'live',status:'UNKNOWN',costBtc:25000,feeBtc:250,createdAt:stamp,accountingNote:'retain'};store.saveOrder(order);
  const reward={id:'reward',orderId:'uncertain',amount:10,confirmed:false};store.reward(reward);
  store.db.prepare('INSERT INTO sessions VALUES (?,?)').run('session',Date.now()+60000);
  store.set('runtime',{balance:80000,errors:0,historyComplete:false});store.set('purchase-quote:open',{id:'open'});store.set('purchase-quote:used',{id:'used',orderId:'uncertain'});
  const result=restoreConfiguration(engine,{settings:{...DEFAULTS,reserve:1000},strategies:[strategy({name:'Imported'})],orders:[],rewards:[],credentials:{key:'ignored'}},{strategyMode:'replace'});
  assert.equal(result.importedStrategies,1);assert.equal(store.get('settings').reserve,1000);assert.equal(store.get('settings').running,false);assert.equal(store.get('settings').liveArmed,false);
  assert.deepEqual(store.orders(),[order]);assert.deepEqual(store.rewards(),[reward]);assert.deepEqual(store.credentials(),{key:'saved-key',secret:'saved-secret',orgId:'mine'});assert.equal(store.get('ledgerOrgId'),'mine');assert.equal(store.get('verified'),true);assert.equal(store.db.prepare('SELECT count(*) AS n FROM sessions').get().n,1);
  assert.equal(store.get('runtime').historyComplete,false);assert.equal(store.get('purchase-quote:open'),null);assert.equal(store.get('purchase-quote:used').orderId,'uncertain');assert.equal(engine.busy,false);assert.equal(store.events().length,1);
});

test('import refuses an in-flight purchase/sync or another process lease and does not pause it',t=>{
  const {store,engine}=setup(t);store.set('settings',state().settings);engine.busy=true;
  assert.throws(()=>restoreConfiguration(engine,state()),e=>e.status===409);assert.equal(store.get('settings').running,true);
  engine.busy=false;assert.equal(store.acquire('other-process'),true);
  assert.throws(()=>restoreConfiguration(engine,state()),e=>e.status===409);assert.equal(store.owns('other-process'),true);assert.equal(store.get('settings').running,true);
});

test('demo restores the same configuration while forcing paper mode and retaining its sample ledger',async()=>{
  const current=state();current.orders=[{id:'demo',status:'ACTIVE',mode:'paper',createdAt:stamp}];
  const api=new DemoApi(current);api.persist=()=>{};api.state.events=[];
  const result=await api.request('/api/import','POST',{backup:configurationBackup(state()),options:{strategyMode:'replace'}});
  assert.equal(result.ok,true);assert.equal(api.state.settings.mode,'paper');assert.equal(api.state.settings.running,false);assert.equal(api.state.settings.liveArmed,false);assert.equal(api.state.strategies[0].enabled,false);assert.equal(api.state.orders[0].id,'demo');
});
