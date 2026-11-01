import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {ManualPurchases} from '../server/manual-purchases.mjs';
import {NiceHash,ApiError} from '../server/nicehash.mjs';
import {applyPurchaseFailure,legacyTeamRejection} from '../server/purchase-failures.mjs';
import {DEFAULTS,STRATEGY_DEFAULTS,totals,pickQuote,guard} from '../public/core.mjs';
import {syncPresentation} from '../public/runtime-status.mjs';

const badId='6bc903de-f736-4add-a1fc-436dd5cd2b89',freshId='99999999-9999-4999-8999-999999999999';
const path='/main/api/v2/hashpower/shared/ticket/'+badId;
const rejection=()=>new ApiError('NiceHash rejected POST '+path+' (HTTP 404, code 110). Team ticket not found',{status:404,nicehashCode:110,method:'POST',path,providerMessage:'Team ticket not found'});
const pkg=(id=badId)=>({id,name:'Team Silver',coin:'BCH',team:true,market:'BTC',available:true,price:10000,costBtc:10000,minShare:10000,teamShares:68,teamCommitted:680000,blockRewards:[{coin:'BCH',amount:312500000}],quotedAt:new Date().toISOString(),duration:3600,odds:100});
const legacy=()=>({id:'failed-intent',requestId:'failed-request',strategyId:'s',mode:'live',kind:'team',packageId:badId,externalId:badId,status:'FAILED',source:'Strategy engine',costBtc:10000,feeBtc:100,createdAt:new Date().toISOString(),error:'NiceHash rejected POST /main/api/v2/hashpower/shared/ticket/'+badId+' (HTTP 404, code 110).',syncPending:{reason:'No membership returned'}});
function setup(t,{running=true}={}){
 const dir=mkdtempSync(join(tmpdir(),'fp-purchase-recovery-')),store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});store.saveCredentials({orgId:'mine',key:'mock-key',secret:'mock-secret'});
 store.set('settings',{...DEFAULTS,mode:'live',running,liveArmed:true});store.set('verified',true);
 const engine=new Engine(store),calls={posts:[],reads:[],order:[]};let packages=[pkg()],catalogue=[];
 const api={credentials:{orgId:'mine'},syncClock:async()=>{},balances:async()=>({currencies:[{currency:'BTC',available:.02,btcRate:1}]}),
  pages:async p=>{calls.order.push('history');return p.endsWith('/shared/order')?catalogue:[];},
  packages:async()=>{calls.order.push('catalogue');return packages.map(p=>({...p,quotedAt:new Date().toISOString()}));},
  ticket:async id=>{calls.reads.push(id);throw new Error('No owned package');},
  payoutDestination:async()=>({fields:{},requiresTwofa:false}),
  buy:async(q,s,requestId)=>{calls.posts.push({id:q.id,requestId});if(q.id===badId)throw rejection();return {id:q.id,status:'PENDING',costBtc:q.costBtc};}};
 engine.client=()=>api;
 store.strategy({...STRATEGY_DEFAULTS,id:'s',name:'Team Silver',enabled:true,kind:'team',mode:'team',coin:'BCH',packageName:'Team Silver',maxPrice:10000,budget:1000000,minTeamShares:0,stopOnWin:false});
 return {store,engine,api,calls,setPackages:p=>packages=p,setCatalogue:c=>catalogue=c};
}

test('a rejected team attempt does not fabricate membership or debit and preserves verified account history',async t=>{
 const {store,engine,calls}=setup(t);await engine.tick();const o=store.orders()[0];
 assert.equal(o.status,'FAILED');assert.equal(o.externalId,null);assert.equal(o.attemptedTeamId,badId);assert.equal(o.feeBtc,0);assert.equal(o.submissionFailure.rejected,true);assert.equal(o.submissionFailure.httpStatus,404);
 assert.equal(store.get('settings').running,true);assert.equal(store.get('settings').liveArmed,true);assert.equal(store.get('runtime').historyComplete,true);assert.equal(store.get('verified'),true);assert.equal(store.get('runtime').balance,2000000);assert.equal(totals(store.orders(),[],{mode:'live'}).spend,0);assert.equal(store.strategies()[0].lastBuyAt,null);assert.equal(calls.posts.length,1);
 await engine.sync();assert.equal(store.get('runtime').historyComplete,true);assert.deepEqual(calls.reads,[]);
});

test('a new strategy evaluation selects a different live lobby without retrying the rejected target',async t=>{
 const {store,engine,calls,setPackages}=setup(t);await engine.tick();setPackages([pkg(),pkg(freshId)]);await engine.tick();
 assert.deepEqual(calls.posts.map(p=>p.id),[badId,freshId]);assert.notEqual(calls.posts[0].requestId,calls.posts[1].requestId);assert.equal(store.orders().filter(o=>o.status==='PENDING').length,1);assert.equal(totals(store.orders(),[],{mode:'live'}).spend,10000);
 assert.equal(calls.order.indexOf('history')<calls.order.indexOf('catalogue'),true);assert.equal(store.get('settings').liveArmed,true);
});

test('a rejected target still present in a stale catalogue is not resubmitted',async t=>{
 const {store,engine,calls}=setup(t);await engine.tick();await engine.tick();assert.equal(calls.posts.length,1);assert.equal(store.get('packages')[0].available,false);assert.match(store.get('packages')[0].availabilityReason,/unavailable/);
});

test('legacy 404/110 failures are repaired without querying a membership that was never created',async t=>{
 const {store,engine,calls,setCatalogue}=setup(t);store.saveOrder(legacy());setCatalogue([{id:badId,status:'WAITING',members:[],currencyAlgoTicket:{currencyMarket:'BTC'}}]);
 const result=await engine.sync();assert.equal(result.historyComplete,true);assert.equal(store.orders()[0].externalId,null);assert.equal(store.orders()[0].attemptedTeamId,badId);assert.equal(store.orders()[0].syncPending,undefined);assert.deepEqual(calls.reads,[]);
 engine.repairRejectedAttempts();assert.equal(store.events().filter(e=>e.message.startsWith('Rejected team attempt')).length,1);
});

test('uncertain, mismatched or manually reconciled legacy attempts are never released by text matching',()=>{
 for(const o of [{...legacy(),status:'UNKNOWN'},{...legacy(),error:'Network timed out'},{...legacy(),externalId:freshId},{...legacy(),accountingOverride:{note:'manual'}}])assert.equal(legacyTeamRejection(o),null);
});

test('funded or reward-bearing records are not unlinked by rejected-intent migration',t=>{
 const {store,engine}=setup(t);store.saveOrder(legacy());store.reward({id:'proof-of-reward',orderId:'failed-intent',coin:'BCH',amount:1});engine.repairRejectedAttempts();assert.equal(store.orders()[0].externalId,badId);
});

test('a fixed team choice remains fixed until the user chooses to follow matching teams',async t=>{
 const {store,engine}=setup(t);store.saveOrder({...legacy(),externalId:null,submissionFailure:{rejected:true,httpStatus:404,path}});
 const fixed={...store.strategies()[0],packageId:badId};assert.equal(pickQuote([pkg(),pkg(freshId)],fixed,store.orders()),null);
 assert.equal(pickQuote([pkg(),pkg(freshId)],{...fixed,packageId:''},store.orders()).id,freshId);
 assert.match(guard({...store.state(),runtime:{lastSync:new Date().toISOString(),historyComplete:true,balance:2000000}},fixed,pkg()),/rejected as unavailable/);
});

test('alternative-route 404 attempts do not blacklist a REST quote or erase the failed audit record',async t=>{
 const {store,engine}=setup(t);store.saveOrder({...legacy(),error:'NiceHash rejected POST /hashpower/api/v2/hashpower/shared/ticket/'+badId+' (HTTP 404, code 110).'});engine.repairRejectedAttempts();
 const old=store.orders()[0];assert.equal(old.status,'FAILED');assert.equal(old.submissionFailure.path,'/hashpower/api/v2/hashpower/shared/ticket/'+badId);assert.equal(old.externalId,null);
 const fixed={...store.strategies()[0],packageId:badId};assert.equal(pickQuote([pkg()],fixed,store.orders()).id,badId);
 store.set('runtime',{historyComplete:true,lastSync:new Date().toISOString(),balance:2000000});
 assert.equal(guard(store.state(),fixed,pkg()),null);await engine.refreshPackages();assert.equal(store.get('packages')[0].available,true);assert.equal(store.orders().length,1);
 store.saveOrder({id:'owned-membership',mode:'live',status:'PENDING',kind:'team',packageId:badId,costBtc:10000,createdAt:new Date().toISOString()});
 assert.equal(pickQuote([pkg()],fixed,store.orders()),null);assert.match(guard(store.state(),fixed,pkg()),/Already joined this team/);
});

test('restoring REST routes never releases an uncertain purchase made on the alternative route',t=>{
 const {store,engine}=setup(t);store.saveOrder({...legacy(),status:'UNKNOWN',error:'Purchase response was not received',submissionFailure:{rejected:false,uncertain:true,httpStatus:504,path:'/hashpower/api/v2/hashpower/shared/ticket/'+badId}});
 engine.repairRejectedAttempts();store.set('runtime',{historyComplete:true,lastSync:new Date().toISOString(),balance:2000000});
 assert.equal(store.orders()[0].externalId,badId);assert.equal(store.orders()[0].status,'UNKNOWN');assert.equal(totals(store.orders(),[],{mode:'live'}).spend,10100);
 assert.match(guard(store.state(),store.strategies()[0],pkg(freshId)),/Unresolved purchase/);
});

test('a stale syncPending flag on a failed attempt does not hold buying or show an active account check',t=>{
 const {store}=setup(t);store.set('runtime',{historyComplete:true});const old={...legacy(),requestId:null};store.saveOrder(old);
 const state={...store.state(),connection:{configured:true,verified:true}};assert.equal(syncPresentation(state).checking.length,0);assert.equal(syncPresentation(state).waiting,false);
});

test('manual 404 rejection keeps an already paused engine paused and its review single-use',async t=>{
 const {store,engine,calls,setPackages}=setup(t,{running:false}),manual=new ManualPurchases(engine);const q=await manual.quote({packageId:badId});
 const result=await manual.buy(q.id);assert.equal(result.order.status,'FAILED');assert.equal(result.order.externalId,null);assert.equal(store.get('settings').running,false);assert.equal(store.get('settings').liveArmed,true);assert.equal(store.get('runtime').historyComplete,true);
 const replay=await manual.buy(q.id);assert.equal(replay.replayed,true);assert.equal(calls.posts.length,1);
 setPackages([pkg(freshId)]);const next=await manual.quote({packageId:freshId});await manual.buy(next.id);assert.deepEqual(calls.posts.map(p=>p.id),[badId,freshId]);
});

test('unknown POST responses still retain the target, reserve cost and disarm buying',async t=>{
 const {store,engine,api}=setup(t);api.buy=async()=>{throw new ApiError('Gateway timeout',{status:504,method:'POST',path,uncertain:true});};await engine.tick();
 const o=store.orders()[0];assert.equal(o.status,'UNKNOWN');assert.equal(o.externalId,badId);assert.equal(o.submissionFailure.rejected,false);assert.equal(store.get('settings').running,false);assert.equal(store.get('settings').liveArmed,false);assert.equal(totals(store.orders(),[],{mode:'live'}).spend,10100);
});

test('permission rejection still disarms while a genuine pre-existing history hold is preserved',t=>{
 const {store,engine}=setup(t);store.set('runtime',{historyComplete:false,syncStatus:'waiting',syncWarnings:[{reason:'actual ownership check'}]});
 engine.recordError(rejection());assert.equal(store.get('runtime').historyComplete,false);assert.equal(store.get('runtime').syncWarnings.length,1);
 engine.recordError(new ApiError('No buying permission',{status:403,method:'POST',path}));assert.equal(store.get('settings').liveArmed,false);assert.equal(store.get('verified'),false);
});

test('provider error messages are preserved with credentials and one-use tokens redacted',async()=>{
 const c={key:'private-api-key',secret:'private-api-secret',orgId:'mine'},token='654321';
 const api=new NiceHash(c,async()=>new Response(JSON.stringify({errors:[{code:110,message:'Ticket not found '+c.key+' '+c.secret+' '+token}]}),{status:404}));
 await assert.rejects(()=>api.request('POST',path,{body:{},twofaToken:token}),e=>e.upstreamStatus===404&&e.providerMessage.includes('Ticket not found')&&!e.message.includes(c.key)&&!e.message.includes(c.secret)&&!e.message.includes(token));
});

test('HTTP 408 and 409 POST responses remain uncertain and are never released as rejections',async()=>{
 for(const status of [408,409]){const api=new NiceHash({key:'key',secret:'secret',orgId:'mine'},async()=>new Response('{"errors":[{"code":110,"message":"Request outcome requires verification"}]}',{status}));
  let caught;try{await api.request('POST',path,{body:{}});}catch(e){caught=e;}assert.equal(caught.uncertain,true);const o=legacy();applyPurchaseFailure(o,caught);assert.equal(o.status,'UNKNOWN');assert.equal(o.externalId,badId);assert.equal(o.submissionFailure.rejected,false);
 }
});
