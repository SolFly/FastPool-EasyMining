import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {ApiError} from '../server/nicehash.mjs';
import {VERSION,DEFAULTS,STRATEGY_DEFAULTS,normalizePackage,totals} from '../public/core.mjs';
import {purchaseDiagnostics,rejectionExplanation} from '../public/purchase-diagnostics.mjs';

const reportedId='c7f74c51-ccb6-4aa0-a19c-3f2f8462a8d8';
const freshId='99999999-9999-4999-8999-999999999999';
const pkg=(extra={})=>({id:reportedId,name:'Team Gold',coin:'BTC',market:'BTC',team:true,teamState:'OPEN',status:'WAITING',available:true,price:10000,minShare:10000,costBtc:10000,teamShares:68,teamCommitted:680000,quotedAt:new Date().toISOString(),duration:3600,...extra});
function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'fp-team-checks-')),store=new Store(dir),engine=new Engine(store);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.set('settings',{...DEFAULTS,mode:'live',running:true,liveArmed:true});store.set('verified',true);
  store.strategy({...STRATEGY_DEFAULTS,id:'s',name:'Test team',mode:'team',kind:'team',enabled:true,packageName:'Team Gold',minTeamShares:50,stopOnWin:false});
  const provider={catalogue:[pkg()],posts:[],refreshes:[],diagnosticReads:0,payoutHook:()=>{},postHook:()=>{}};
  engine.sync=async()=>store.set('runtime',{...store.get('runtime'),lastSync:new Date().toISOString(),balance:2000000,historyComplete:true,errors:0});
  engine.refreshPackages=async options=>{provider.refreshes.push(options);store.set('packages',provider.catalogue.map(q=>({...q,quotedAt:new Date().toISOString()})));};
  const api={offset:37,payoutDestination:async()=>{await provider.payoutHook();return {fields:{},requiresTwofa:false};},
    packages:async()=>{provider.diagnosticReads++;if(provider.readError)throw provider.readError;return provider.catalogue;},
    buy:async(q,s,requestId)=>{
      const intent=store.orders().find(o=>o.requestId===requestId);assert.equal(intent.status,'SUBMITTING');assert.equal(intent.purchaseCheck.before.id,q.id);
      provider.posts.push({id:q.id,requestId});await provider.postHook(q,s,requestId);
      if(provider.reject)throw new ApiError('NiceHash rejected POST /main/api/v2/hashpower/shared/ticket/'+q.id+' (HTTP 404, code 110). The requested resource was not found',{status:404,nicehashCode:110,method:'POST',path:'/main/api/v2/hashpower/shared/ticket/'+q.id,requestId});
      return {id:q.id,costBtc:q.costBtc,status:'PENDING'};
    }};
  engine.client=()=>api;return {store,engine,provider,api};
}

test('the v1.2.4 selected target is submitted once; a subsequent rejection releases only the failed intent',async t=>{
  const {store,engine,provider}=setup(t);provider.payoutHook=()=>{provider.catalogue=[];provider.reject=true;};
  await engine.tick();assert.equal(provider.posts.length,1);assert.equal(store.orders()[0].status,'FAILED');assert.equal(store.strategies()[0].lastBuyAt,null);
  assert.equal(store.get('runtime').historyComplete,true);assert.equal(store.get('settings').liveArmed,true);assert.equal(totals(store.orders(),[],{mode:'live'}).spend,0);
  assert.deepEqual(provider.refreshes,[undefined]);
});
test('local spending and reserve changes during destination lookup still prevent submission',async t=>{
  for(const change of [{maxOrder:1},{reserve:2000000}]){
    const {store,engine,provider}=setup(t);provider.payoutHook=()=>store.set('settings',{...store.get('settings'),...change});await engine.tick();
    assert.equal(provider.posts.length,0);assert.equal(store.orders().length,0);assert.equal(store.get('runtime').historyComplete,true);assert.equal(store.get('settings').running,true);
  }
});
test('a pause arriving during ordinary team payout lookup prevents submission',async t=>{
  const {store,engine,provider}=setup(t);provider.payoutHook=()=>engine.pause('Administrator paused while preparing');
  await engine.tick();assert.equal(provider.posts.length,0);assert.equal(store.orders().length,0);assert.equal(store.get('settings').running,false);
});
test('the original per-cycle catalogue is retained; a rejected target is quarantined before the next evaluation',async t=>{
  const {store,engine,provider}=setup(t),silver=pkg({id:'77777777-7777-4777-8777-777777777777',name:'Team Silver',coin:'BCH'});
  provider.catalogue=[pkg(),silver];store.strategy({...store.strategies()[0],id:'s2',coin:'BCH',packageName:'Team Silver'});
  provider.postHook=q=>{provider.catalogue=[pkg(),{...silver,id:freshId}];if(q.id===silver.id)throw new ApiError('Rejected unavailable target',{status:404,nicehashCode:110,method:'POST',path:'/main/api/v2/hashpower/shared/ticket/'+silver.id});};
  await engine.tick();assert.deepEqual(provider.posts.map(p=>p.id),[reportedId,silver.id]);assert.equal(store.orders().filter(o=>o.status==='PENDING').length,1);
  await engine.tick();assert.deepEqual(provider.posts.map(p=>p.id),[reportedId,silver.id,freshId]);
});
test('a 404 records that the exact team remained listed without claiming an expired lobby or changing the route',async t=>{
  const {store,engine,provider}=setup(t);provider.reject=true;await engine.tick();
  const o=store.orders()[0],check=o.submissionFailure.teamCheck;
  assert.equal(check.finding,'still-listed-after-rejection');assert.equal(check.before.id,reportedId);assert.equal(check.after.listed,true);assert.equal(check.clockOffsetMs,37);
  assert.equal(check.additionalCostBtc,10000);assert.equal(o.status,'FAILED');assert.equal(o.externalId,null);assert.equal(totals(store.orders(),[],{mode:'live'}).spend,0);
  assert.equal(provider.posts.length,1);assert.equal(provider.diagnosticReads,1);assert.equal(store.get('runtime').historyComplete,true);assert.equal(store.get('settings').liveArmed,true);
  assert.equal(store.get('runtime').lastPurchaseRejection.teamCheck.finding,'still-listed-after-rejection');assert.match(rejectionExplanation(check),/cause is unconfirmed/);
});
test('a missing team after rejection is recorded as later evidence, not proof of its state at the POST',async t=>{
  const {store,engine,provider}=setup(t);provider.reject=true;provider.postHook=()=>{provider.catalogue=[];};await engine.tick();
  const check=store.orders()[0].submissionFailure.teamCheck;assert.equal(check.finding,'not-listed-after-rejection');assert.equal(check.before.id,reportedId);assert.equal(check.after.listed,false);assert.match(rejectionExplanation(check),/at submission is unconfirmed/);
});
test('a failed diagnostic read cannot erase or replay a confirmed rejection or create a history hold',async t=>{
  const {store,engine,provider}=setup(t);provider.reject=true;provider.readError=new ApiError('Read failed',{status:503,method:'GET'});await engine.tick();
  const o=store.orders()[0];assert.equal(o.submissionFailure.httpStatus,404);assert.equal(o.submissionFailure.teamCheck.finding,'verification-read-failed');assert.equal(provider.posts.length,1);assert.equal(o.status,'FAILED');assert.equal(store.get('runtime').historyComplete,true);
});
test('uncertain POST outcomes retain the reservation and never run rejection inspection or another POST',async t=>{
  const {store,engine,provider}=setup(t);provider.postHook=()=>{throw new ApiError('Timeout',{uncertain:true,method:'POST',path:'/main/api/v2/hashpower/shared/ticket/'+reportedId});};
  await engine.tick();const o=store.orders()[0];assert.equal(o.status,'UNKNOWN');assert.equal(o.externalId,reportedId);assert.equal(totals(store.orders(),[],{mode:'live'}).spend,10100);assert.equal(provider.posts.length,1);assert.equal(provider.diagnosticReads,0);assert.equal(store.get('settings').liveArmed,false);
});
test('deadline metadata does not override the original WAITING/COUNTDOWN and SOLD_OUT availability contract',()=>{
  const now=Date.now(),raw={id:reportedId,status:'WAITING',state:'OPEN',lifeTimeTill:new Date(now-1000).toISOString(),minShareAmount:.0001,addedAmount:.0068,currencyAlgoTicket:{name:'Team Gold',price:.01,currencyMarket:'BTC',currencyAlgo:{currency:'BTC'}}};
  const expired=normalizePackage(raw,new Date(now).toISOString(),true);assert.equal(expired.available,true);assert.equal(expired.buyUntil,raw.lifeTimeTill);
  assert.equal(normalizePackage({...raw,lifeTimeTill:null},new Date(now).toISOString(),true).available,true);
  assert.equal(normalizePackage({...raw,state:'SOLD_OUT'},new Date(now).toISOString(),true).available,false);
  assert.equal(normalizePackage({...raw,status:'SPAWNING'},new Date(now).toISOString(),true).available,false);
  assert.equal(normalizePackage({...raw,lifeTimeTill:'bad'},new Date(now).toISOString(),true).available,true);
});
test('diagnostics whitelist omits credentials, addresses, raw errors and provider bodies while retaining before/after evidence',async t=>{
  const {store,engine,provider}=setup(t);provider.reject=true;await engine.tick();const state=store.state();
  const secrets=['DO_NOT_EXPORT_KEY','DO_NOT_EXPORT_SECRET','DO_NOT_EXPORT_ORG','DO_NOT_EXPORT_PASSWORD','DO_NOT_EXPORT_ADDRESS','DO_NOT_EXPORT_TOKEN','DO_NOT_EXPORT_BODY'];
  Object.assign(state,{credentials:{key:secrets[0],secret:secrets[1]},organizationId:secrets[2],password:secrets[3],twofaToken:secrets[5]});
  state.orders[0].payoutAddress=secrets[4];state.orders[0].submissionFailure.providerMessage=secrets[6];state.orders[0].error=secrets[0];state.strategies[0].payoutAddress=secrets[4];
  state.orders[0].submissionFailure.teamCheck.before.extra=secrets[1];state.runtime.rawProvider=secrets[6];
  const output=purchaseDiagnostics(state,{configured:true,verified:true,baseUrl:'https://api2.nicehash.com',organizationId:secrets[2],secret:secrets[1]}),text=JSON.stringify(output);
  for(const secret of secrets)assert.ok(!text.includes(secret));assert.equal(output.failures[0].teamId,reportedId);assert.equal(output.failures[0].requestId,provider.posts[0].requestId);assert.equal(output.failures[0].teamCheck.finding,'still-listed-after-rejection');assert.equal(output.version,VERSION);
  assert.match(rejectionExplanation(null),/does not identify why/);
});
