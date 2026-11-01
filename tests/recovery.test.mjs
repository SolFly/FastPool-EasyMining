import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {ApiError} from '../server/nicehash.mjs';
import {DEFAULTS,STRATEGY_DEFAULTS,totals,guard,isCurrent} from '../public/core.mjs';
import {rewardSummary} from '../public/rewards.mjs';
import {syncPresentation} from '../public/runtime-status.mjs';
const teamId='22222222-2222-2222-2222-222222222222',executionId='33333333-3333-3333-3333-333333333333';
const now=()=>new Date().toISOString();
const team=()=>({id:teamId,status:'ACTIVE',currencyAlgoTicket:{currencyMarket:'BTC',name:'Team Gold',currencyAlgo:{currency:'BTC'}},members:[{organizationId:'mine',addedAmount:.0001,paymentStatus:'OK',claimed:true,rewards:[{coin:'BTC',rewardAmount:.001,rewardFeeAmount:0}]}],orderDetails:{id:executionId,soloReward:[{coin:'BTC',depositComplete:true}]}});
const sharedIndex=()=>({id:executionId,sharedTicketId:teamId,myAddedAmount:.0001,amount:1,createdTs:now(),status:'ACTIVE',soloReward:[{id:'whole-team-reward',coin:'BTC',payoutReward:312500000,depositComplete:true,createdTs:now()}]});
function setup(t,{running=true,armed=true}={}){
 const dir=mkdtempSync(join(tmpdir(),'fp-recovery-')),store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{force:true,recursive:true});});
 store.saveCredentials({orgId:'mine',key:'mock-key',secret:'mock-secret'});store.set('settings',{...DEFAULTS,mode:'live',running,liveArmed:armed,feeBufferBps:0,startHour:'00:00',endHour:'23:59'});
 const engine=new Engine(store),calls={buy:0,balances:0,tickets:[]};let account=[],catalogue=[],detail=team();
 const api={credentials:{orgId:'mine'},syncClock:async()=>{},balances:async()=>{calls.balances++;return {currencies:[{currency:'BTC',available:'0.02',btcRate:1}]};},pages:async path=>path.endsWith('/shared/order')?catalogue:account,
 ticket:async id=>{calls.tickets.push(id);return structuredClone(detail);},buy:async(q,s,id)=>{calls.buy++;return {id:'local-'+calls.buy,status:'PENDING',costBtc:q.costBtc};}};
 engine.client=()=>api;engine.refreshPackages=async()=>{store.set('packages',[{id:'solo-package',name:'Gold S',coin:'BTC',market:'BTC',costBtc:10000,available:true,quotedAt:now(),duration:3600,team:false}]);};
 const strategy={...STRATEGY_DEFAULTS,id:'s',enabled:true,stopOnWin:false,intervalMinutes:1,packageName:'Gold S',maxPrice:10000,budget:1000000};
 return {store,engine,api,calls,strategy,setAccount:a=>account=a.map(row=>({organizationId:'mine',...row})),setCatalogue:a=>catalogue=a,setDetail:d=>detail=d};
}
test('an external solo purchase is imported and an already armed running engine continues normally',async t=>{
 const {store,engine,calls,strategy,setAccount}=setup(t);store.strategy(strategy);
 setAccount([{id:'external-solo',amount:.0001,soloMiningCoin:'BTC',status:'ACTIVE',createdTs:now(),soloReward:[]}]);
 await engine.tick();assert.equal(calls.buy,1);assert.equal(store.get('settings').running,true);assert.equal(store.get('settings').liveArmed,true);
 assert.equal(store.orders().filter(o=>o.externalId==='external-solo').length,1);assert.equal(totals(store.orders(),store.rewards(),{mode:'live'}).spend,20000);
});
test('an external shared execution imports only the member spend and rewards, including after leaving the catalogue',async t=>{
 const {store,engine,setAccount,calls}=setup(t);setAccount([sharedIndex()]);
 await engine.sync();await engine.sync();assert.deepEqual(calls.tickets,[teamId,teamId]);assert.equal(store.orders().length,1);
 const o=store.orders()[0];assert.equal(o.kind,'team');assert.equal(o.costBtc,10000);assert.deepEqual(o.providerOrderIds,[executionId]);
 assert.equal(store.rewards().length,1);assert.equal(store.rewards()[0].amount,100000);assert.equal(totals(store.orders(),store.rewards(),{mode:'live'}).spend,10000);assert.equal(totals(store.orders(),store.rewards(),{mode:'live'}).earned,100000);
 assert.equal(store.get('settings').running,true);assert.equal(store.get('settings').liveArmed,true);
});
test('temporary team membership lag holds buying and resumes automatically on the next verified cycle',async t=>{
 const {store,engine,strategy,calls,setAccount,setDetail}=setup(t);store.strategy(strategy);setAccount([sharedIndex()]);setDetail({...team(),members:null});
 await engine.tick();assert.equal(calls.buy,0);assert.equal(store.get('runtime').historyComplete,false);assert.equal(store.get('runtime').syncStatus,'waiting');assert.equal(store.get('settings').running,true);assert.equal(store.get('settings').liveArmed,true);
 setDetail(team());await engine.background(Date.now()+61000);assert.equal(store.get('runtime').historyComplete,true);assert.equal(calls.buy,1);assert.equal(store.get('settings').running,true);assert.equal(store.get('settings').liveArmed,true);
});
test('account syncing continues while paused and never starts or arms buying',async t=>{
 const {store,engine,calls,strategy,setAccount}=setup(t,{running:false,armed:false});store.strategy(strategy);setAccount([sharedIndex()]);
 await engine.background();assert.equal(store.orders().length,1);assert.equal(calls.buy,0);assert.equal(store.get('settings').running,false);assert.equal(store.get('settings').liveArmed,false);
 await engine.background();assert.equal(calls.balances,1);
});
test('a user pause during a recovery wait remains paused after account verification',async t=>{
 const {store,engine,calls,setAccount,setDetail}=setup(t);setAccount([sharedIndex()]);setDetail({...team(),members:null});await engine.tick();
 engine.pause('User paused');setDetail(team());await engine.background(Date.now()+61000);
 assert.equal(store.get('runtime').historyComplete,true);assert.equal(store.get('settings').running,false);assert.equal(store.get('settings').liveArmed,false);assert.equal(calls.buy,0);
});
test('repeated transient GET failures recover without clearing prior live authorization',async t=>{
 const {store,engine,api,calls,strategy}=setup(t);store.strategy(strategy);const pages=api.pages;
 api.pages=async()=>{throw new ApiError('Temporary provider outage',{status:503});};
 for(let i=1;i<=3;i++)await assert.rejects(()=>engine.background(Date.now()+i*61000),/outage/);
 assert.equal(store.get('runtime').errors,3);assert.equal(store.get('runtime').syncStatus,'retrying');assert.equal(store.get('settings').running,true);assert.equal(store.get('settings').liveArmed,true);assert.equal(calls.buy,0);
 api.pages=pages;await engine.background(Date.now()+241000);assert.equal(store.get('runtime').errors,0);assert.equal(store.get('runtime').historyComplete,true);assert.equal(calls.buy,1);
});
test('authentication rejection still disarms and later read recovery never automatically re-arms',async t=>{
 const {store,engine,api,calls}=setup(t),balances=api.balances;api.balances=async()=>{throw new ApiError('Authentication rejected',{status:401});};
 await assert.rejects(()=>engine.background(),/Authentication/);assert.equal(store.get('settings').liveArmed,false);assert.equal(store.get('settings').running,false);
 api.balances=balances;await engine.background(Date.now()+61000);assert.equal(store.get('verified'),true);assert.equal(store.get('settings').liveArmed,false);assert.equal(store.get('settings').running,false);assert.equal(calls.buy,0);
});
test('an incomplete record does not stop import of other verified account purchases',async t=>{
 const {store,engine,setAccount}=setup(t);setAccount([{id:'bad',amount:null,status:'ACTIVE',soloReward:[]},{id:'good',amount:.0001,status:'ACTIVE',soloMiningCoin:'BTC',createdTs:now(),soloReward:[]}]);
 const result=await engine.sync();assert.equal(result.historyComplete,false);assert.equal(result.warnings[0].orderId,'bad');assert.equal(store.orders().length,1);assert.equal(store.orders()[0].externalId,'good');assert.equal(store.get('settings').liveArmed,true);
});
test('verified team links archive legacy whole-team duplicates and their rewards from totals without deleting audit data',async t=>{
 const {store,engine,setAccount}=setup(t);store.saveOrder({id:'old-duplicate',externalId:executionId,mode:'live',kind:'solo',source:'NiceHash import',costBtc:100000000,status:'COMPLETED',createdAt:now()});
 store.reward({id:'old-whole-reward',orderId:'old-duplicate',coin:'BTC',amount:312500000,confirmed:true,valueBtc:312500000,createdAt:now()});setAccount([sharedIndex()]);
 await engine.sync();await engine.sync();assert.equal(store.orders().length,2);assert.equal(store.orders().filter(isCurrent).length,1);assert.ok(store.orders().find(o=>o.id==='old-duplicate').supersededBy);assert.equal(store.rewards().length,2);
 const summary=totals(store.orders(),store.rewards(),{mode:'live'});assert.equal(summary.spend,10000);assert.equal(summary.earned,100000);assert.equal(rewardSummary(store.orders(),store.rewards(),{mode:'live'})[0].confirmed,100000);
});
test('explicit team links do not silently overwrite manually reconciled duplicate accounting',async t=>{
 const {store,engine,setAccount}=setup(t);store.saveOrder({id:'manual-record',externalId:executionId,mode:'live',kind:'solo',source:'NiceHash import',costBtc:100000000,status:'COMPLETED',createdAt:now(),accountingOverride:{note:'verified manually'}});setAccount([sharedIndex()]);
 const result=await engine.sync();assert.equal(result.historyComplete,false);assert.equal(store.orders().length,1);assert.equal(store.orders()[0].costBtc,100000000);assert.equal(store.orders()[0].supersededBy,undefined);
});
test('external spending still enforces the daily cap while preserving the running state',async t=>{
 const {store,engine,strategy,calls,setAccount}=setup(t);store.strategy(strategy);setAccount([{id:'outside',amount:.00095,soloMiningCoin:'BTC',status:'COMPLETED',createdTs:now(),soloReward:[]}]);
 await engine.tick();assert.equal(calls.buy,0);assert.equal(store.get('runtime').decisions[0].reason,'Daily spending cap');assert.equal(store.get('settings').running,true);assert.equal(store.get('settings').liveArmed,true);
});
test('background retry obeys the account interval and shares the manual/strategy lease',async t=>{
 const {store,engine,calls}=setup(t,{running:false});store.set('runtime',{lastSyncAttempt:now()});
 assert.deepEqual(await engine.background(),{idle:true});assert.equal(calls.balances,0);
 store.acquire('other');await assert.rejects(()=>engine.background(Date.now()+61000),/busy/);store.release('other');assert.equal(calls.balances,0);
 store.set('settings',{...store.get('settings'),autoSync:false});assert.deepEqual(await engine.background(Date.now()+61000),{idle:true});
});
test('UI recovery text distinguishes automatic checks from a user-paused engine',()=>{
 const state={settings:{...DEFAULTS,mode:'live',running:true,liveArmed:true},runtime:{historyComplete:false,syncStatus:'waiting'},connection:{configured:true,verified:true},orders:[]};
 assert.equal(syncPresentation(state).engine,'Waiting for account sync');assert.equal(syncPresentation(state).automatic,true);
 state.settings.running=false;assert.equal(syncPresentation(state).engine,'Engine paused');assert.equal(syncPresentation(state).automatic,true);
});
test('legacy same-ID shared rows are converted to personal team accounting with old whole-team rewards archived',async t=>{
 const {store,engine,setAccount}=setup(t);store.saveOrder({id:'legacy-same',externalId:teamId,mode:'live',kind:'solo',source:'NiceHash import',costBtc:100000000,status:'UNKNOWN',createdAt:now()});
 store.reward({id:'old-reward',orderId:'legacy-same',coin:'BTC',amount:312500000,confirmed:true,valueBtc:312500000,createdAt:now()});
 setAccount([{...sharedIndex(),id:teamId}]);await engine.sync();assert.equal(store.orders().length,1);assert.equal(store.orders()[0].id,'legacy-same');assert.equal(store.orders()[0].kind,'team');assert.equal(store.orders()[0].costBtc,10000);
 assert.ok(store.rewards().find(r=>r.id==='old-reward').supersededBy);assert.equal(totals(store.orders(),store.rewards(),{mode:'live'}).earned,100000);
});
test('a shared summary without sharedTicketId uses a verified catalogue execution link before probing a guessed team ID',async t=>{
 const {store,engine,calls,setAccount,setCatalogue}=setup(t);const row=sharedIndex();delete row.sharedTicketId;setAccount([row]);setCatalogue([team()]);
 await engine.sync();await engine.sync();assert.equal(store.get('runtime').historyComplete,true);assert.equal(store.orders().length,1);assert.deepEqual(calls.tickets,[teamId,teamId]);assert.equal(store.orders()[0].costBtc,10000);
});
test('additional externally bought shares on an older team count against today’s spending cap',async t=>{
 const {store,engine,calls,strategy,setAccount,setDetail}=setup(t);store.strategy(strategy);store.set('settings',{...store.get('settings'),dailyCap:12000});
 store.saveOrder({id:'older-team',externalId:teamId,packageId:teamId,mode:'live',kind:'team',source:'NiceHash import',costBtc:95000,status:'ACTIVE',createdAt:new Date(Date.now()-3*86400000).toISOString()});
 const detail=team();detail.members[0].addedAmount=.001;detail.members[0].rewards=[];setDetail(detail);setAccount([sharedIndex()]);
 await engine.tick();assert.equal(calls.buy,0);assert.equal(store.get('runtime').decisions[0].reason,'Daily spending cap');assert.equal(store.orders()[0].costBtc,100000);assert.equal(store.orders()[0].spendHistory.length,2);
 assert.equal(totals(store.orders(),store.rewards(),{mode:'live',from:Date.now()-60000}).spend,5000);assert.equal(totals(store.orders(),store.rewards(),{mode:'live'}).spend,100000);
});
test('a known team ID without shared markers never overwrites personal cost with a whole-team amount',async t=>{
 const {store,engine,setAccount}=setup(t);store.saveOrder({id:'known',externalId:teamId,packageId:teamId,mode:'live',kind:'team',source:'NiceHash import',costBtc:10000,status:'ACTIVE',createdAt:now()});
 setAccount([{id:teamId,amount:1,status:'ACTIVE',soloReward:[]}]);const result=await engine.sync();assert.equal(result.historyComplete,true);assert.equal(store.orders().length,1);assert.equal(store.orders()[0].costBtc,10000);
});
