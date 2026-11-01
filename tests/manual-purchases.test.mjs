import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {ManualPurchases,manualQuote} from '../server/manual-purchases.mjs';
import {DEFAULTS,guard} from '../public/core.mjs';
import {ApiError} from '../server/nicehash.mjs';
const org='11111111-1111-1111-1111-111111111111';
const pkg=()=>({id:'22222222-2222-2222-2222-222222222222',name:'Team Palladium',coin:'LTC',mergeCoin:'DOGE',market:'BTC',price:10000,costBtc:10000,team:true,available:true,quotedAt:new Date().toISOString(),duration:3600,odds:100,teamShares:10});
function setup(t,live=false){
 const dir=mkdtempSync(join(tmpdir(),'fp-manual-')),store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const engine=new Engine(store),manual=new ManualPurchases(engine);let packages=[pkg()],calls=0;
 if(live)store.saveCredentials({orgId:org,key:'mock-key',secret:'mock-secret'});
 store.set('settings',{...DEFAULTS,mode:live?'live':'paper',running:false,liveArmed:live,startHour:'00:00',endHour:'23:59'});
 engine.refreshPackages=async()=>{store.set('packages',packages.map(p=>({...p,quotedAt:new Date().toISOString()})));};
 engine.sync=async()=>store.set('runtime',{lastSync:new Date().toISOString(),balance:2000000,historyComplete:true});
 const api={payoutDestination:async()=>({fields:{},requiresTwofa:false}),buy:async(q,s,id)=>{calls++;assert.equal(store.orders()[0].status,'SUBMITTING');assert.equal(store.get('purchase-quote:'+id).orderId,store.orders()[0].id);return {id:q.id,status:'PENDING',costBtc:q.costBtc};}};
 engine.client=()=>api;
 return {store,engine,manual,api,setPackages:p=>packages=p,calls:()=>calls};
}
test('manual shares buy in paused paper mode, use total cost and leave strategies untouched',async t=>{
 const {store,manual,calls}=setup(t),q=await manual.quote({packageId:pkg().id,shares:3});
 assert.equal(q.costBtc,30000);assert.equal(q.reservedBtc,30300);
 const {order}=await manual.buy(q.id);assert.equal(order.costBtc,30000);assert.equal(order.shares,3);assert.equal(order.source,'Manual paper purchase');assert.equal(order.strategyId,null);
 assert.equal(store.get('settings').running,false);assert.equal(store.strategies().length,0);assert.equal(calls(),0);
 const replay=await manual.buy(q.id);assert.equal(replay.replayed,true);assert.equal(replay.order.id,order.id);assert.equal(store.orders().length,1);
});
test('manual live purchase persists one intent, synchronizes and cannot replay a provider POST',async t=>{
 const {store,manual,calls}=setup(t,true),q=await manual.quote({packageId:pkg().id,shares:2});
 const result=await manual.buy(q.id);assert.equal(result.order.status,'PENDING');assert.equal(calls(),1);assert.equal(store.get('runtime').balance,1980000);
 await manual.buy(q.id);assert.equal(calls(),1);assert.equal(store.orders().length,1);assert.equal(store.get('settings').running,false);
});
test('a manual review keeps its original team UUID without an additional public catalogue dependency',async t=>{
 const {store,manual,api,setPackages,calls}=setup(t,true),q=await manual.quote({packageId:pkg().id,shares:1});
 api.payoutDestination=async()=>{setPackages([{...pkg(),id:'99999999-9999-4999-8999-999999999999'}]);return {fields:{},requiresTwofa:false};};
 const result=await manual.buy(q.id);assert.equal(calls(),1);assert.equal(result.order.packageId,q.packageId);assert.equal(store.get('purchase-quote:'+q.id).orderId,result.order.id);assert.equal(store.get('settings').liveArmed,true);
});
test('manual arming and spending caps are rechecked after payout lookup before creating a durable intent',async t=>{
 for(const change of [{maxOrder:1},{liveArmed:false}]){
  const {store,manual,api,setPackages,calls}=setup(t,true),q=await manual.quote({packageId:pkg().id,shares:1});
  api.payoutDestination=async()=>{store.set('settings',{...store.get('settings'),...change});return {fields:{},requiresTwofa:false};};
  await assert.rejects(()=>manual.buy(q.id),/ceiling|not armed/);assert.equal(calls(),0);assert.equal(store.orders().length,0);
 }
});
test('manual live buying requires arming, complete history and all global caps',async t=>{
 const {store,manual,engine,calls}=setup(t,true),q=await manual.quote({packageId:pkg().id,shares:2});
 store.set('settings',{...store.get('settings'),liveArmed:false});await assert.rejects(()=>manual.buy(q.id),/Arm live buying/);
 store.set('settings',{...store.get('settings'),liveArmed:true});engine.sync=async()=>store.set('runtime',{lastSync:new Date().toISOString(),balance:2000000,historyComplete:false});
 await assert.rejects(()=>manual.buy(q.id),/history is incomplete/);
 engine.sync=async()=>store.set('runtime',{lastSync:new Date().toISOString(),balance:2000000,historyComplete:true});
 store.set('settings',{...store.get('settings'),maxOrder:20000});await assert.rejects(()=>manual.buy(q.id),/ceiling/);assert.equal(calls(),0);assert.equal(store.orders().length,0);
});
test('manual buying includes imported external spend and wallet reserve',async t=>{
 const {store,manual,calls,engine}=setup(t,true),q=await manual.quote({packageId:pkg().id,shares:1});
 store.saveOrder({id:'imported',mode:'live',kind:'solo',status:'COMPLETED',costBtc:95000,createdAt:new Date().toISOString()});
 await assert.rejects(()=>manual.buy(q.id),/Daily spending cap/);
 store.set('settings',{...store.get('settings'),dailyCap:200000});engine.sync=async()=>store.set('runtime',{lastSync:new Date().toISOString(),balance:105000,historyComplete:true});
 await assert.rejects(()=>manual.buy(q.id),/wallet reserve/);assert.equal(calls(),0);
});
test('a higher price, expired review, changed mode or changed account never submits',async t=>{
 const {store,manual,setPackages,calls}=setup(t,true),q=await manual.quote({packageId:pkg().id,shares:1});
 setPackages([{...pkg(),costBtc:10001}]);await assert.rejects(()=>manual.buy(q.id),/ceiling/);
 store.set('purchase-quote:'+q.id,{...q,expiresAt:new Date(Date.now()-1).toISOString()});await assert.rejects(()=>manual.buy(q.id),/expired/);
 store.set('purchase-quote:'+q.id,q);store.set('settings',{...store.get('settings'),mode:'paper'});await assert.rejects(()=>manual.buy(q.id),/Mode or account changed/);
 store.set('settings',{...store.get('settings'),mode:'live'});store.saveCredentials({orgId:'different',key:'k',secret:'s'});await assert.rejects(()=>manual.buy(q.id),/Mode or account changed/);assert.equal(calls(),0);
});
test('uncertain manual response reserves cost, disarms buying and is never retried',async t=>{
 const {store,manual,api}=setup(t,true);let calls=0;api.buy=async()=>{calls++;throw new ApiError('test timeout',{uncertain:true});};
 const q=await manual.quote({packageId:pkg().id,shares:2}),result=await manual.buy(q.id);
 assert.equal(result.order.status,'UNKNOWN');assert.equal(result.order.costBtc,20000);assert.equal(result.order.feeBtc,200);assert.equal(store.get('settings').liveArmed,false);
 assert.equal((await manual.buy(q.id)).order.status,'UNKNOWN');assert.equal(calls,1);
});
test('manual quote cannot bypass eligibility, share validation, currency or merged destinations',()=>{
 const p=pkg();assert.throws(()=>manualQuote([p],{packageId:p.id,shares:1.5},DEFAULTS),/shares/);
 assert.throws(()=>manualQuote([{...p,team:false}],{packageId:p.id,shares:2},DEFAULTS),/shares/);
 assert.throws(()=>manualQuote([{...p,market:'EUR'}],{packageId:p.id},DEFAULTS),/Unsupported payment market/);
 assert.throws(()=>manualQuote([{...p,available:false}],{packageId:p.id},DEFAULTS),/available/);
 assert.throws(()=>manualQuote([{...p,mergeCoin:null}],{packageId:p.id,mergePayoutAddress:'DExampleDestination000000'},DEFAULTS),/merged/);
 assert.throws(()=>manualQuote([{...p,withdrawRewards:true}],{packageId:p.id},DEFAULTS),/each reward coin/);
});
test('manual requests share the engine lease and cannot overlap strategy execution',async t=>{
 const {store,engine,manual,calls}=setup(t,true);const q=await manual.quote({packageId:pkg().id,shares:1});
 engine.busy=true;await assert.rejects(()=>manual.buy(q.id),/in progress/);engine.busy=false;
 store.acquire('other-engine');await assert.rejects(()=>manual.buy(q.id),/in progress/);store.release('other-engine');assert.equal(calls(),0);
});
test('a pending existing team entry blocks duplicate membership submissions',async t=>{
 const {store,manual}=setup(t),q=await manual.quote({packageId:pkg().id,shares:1});
 store.saveOrder({id:'existing',mode:'paper',kind:'team',packageId:pkg().id,status:'PENDING',costBtc:10000,createdAt:new Date().toISOString()});
 await assert.rejects(()=>manual.buy(q.id),/Already joined/);
});
test('2FA is sent only to the adapter and is never persisted in a review or ledger',async t=>{
 const {store,manual,api}=setup(t,true);api.payoutDestination=async()=>({fields:{soloMiningRewardAddr:'ltc1qexampledestination0000'},requiresTwofa:true});
 const q=await manual.quote({packageId:pkg().id,shares:1,payoutAddress:'ltc1qexampledestination0000'});assert.equal(q.requiresTwofa,true);
 await assert.rejects(()=>manual.buy(q.id),/2FA code/);assert.equal(store.orders().length,0);
 const token='654321';api.buy=async(q,s,id,options)=>{assert.equal(options.twofaToken,token);return {id:q.id,status:'PENDING',costBtc:q.costBtc};};
 await manual.buy(q.id,{twofaToken:token});assert.ok(!JSON.stringify(store.state()).includes(token));assert.ok(!JSON.stringify(store.get('purchase-quote:'+q.id)).includes(token));
});
test('a pause arriving during payout lookup prevents the manual provider submission',async t=>{
 const {store,manual,api,engine,calls}=setup(t,true),q=await manual.quote({packageId:pkg().id,shares:1});
 api.payoutDestination=async()=>{engine.pause('Stopped during address lookup');return {fields:{},requiresTwofa:false};};
 await assert.rejects(()=>manual.buy(q.id),/not armed/);assert.equal(calls(),0);assert.equal(store.orders().length,0);
});
test('restart recovery retains the quote link and shows the unknown order without resubmitting',async t=>{
 const {store,manual,api}=setup(t,true),q=await manual.quote({packageId:pkg().id,shares:1});
 const order={id:'crashed-order',requestId:q.id,mode:'live',kind:'team',status:'UNKNOWN',costBtc:10000,createdAt:new Date().toISOString()};
 store.saveOrder(order);store.set('purchase-quote:'+q.id,{...q,orderId:order.id});api.buy=async()=>assert.fail('Must not retry a recovered intent');
 const result=await manual.buy(q.id);assert.equal(result.replayed,true);assert.equal(result.order.status,'UNKNOWN');assert.equal(result.order.costBtc,10000);
});
