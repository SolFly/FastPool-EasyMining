import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {ApiError} from '../server/nicehash.mjs';
import {DEFAULTS,STRATEGY_DEFAULTS} from '../public/core.mjs';
function setup(t){const dir=mkdtempSync(join(tmpdir(),'fp-engine-test-'));const store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,dir,engine:new Engine(store)};}
test('credentials are authenticated-encrypted and absent from state',t=>{
  const {store,dir}=setup(t),c={key:'very-private-key',secret:'very-private-secret',orgId:'organization'};store.saveCredentials(c);
  assert.deepEqual(store.credentials(),c);assert.ok(!JSON.stringify(store.state()).includes(c.secret));
  assert.ok(!readFileSync(join(dir,'controller.sqlite')).includes(Buffer.from(c.secret)));
  const encrypted=store.get('credentials');assert.ok(!encrypted.includes(c.key));
});
test('durable intent is saved before a timeout; second cycle cannot buy',async t=>{
  const {store,engine}=setup(t);store.set('settings',{...DEFAULTS,mode:'live',running:true,liveArmed:true,feeBufferBps:0});
  store.strategy({...STRATEGY_DEFAULTS,id:'s',enabled:true,stopOnWin:false});
  store.set('runtime',{lastSync:new Date().toISOString(),balance:2000000,errors:0});
  engine.refreshPackages=async()=>store.set('packages',[{id:'p',name:'Gold S',coin:'BTC',team:false,market:'BTC',available:true,quotedAt:new Date().toISOString(),costBtc:10000,duration:3600,odds:40000}]);
  engine.sync=async()=>{};let calls=0;
  engine.client=()=>({buy:async()=>{calls++;assert.equal(store.orders()[0].status,'SUBMITTING');throw new ApiError('timeout',{uncertain:true});}});
  await engine.tick();assert.equal(calls,1);assert.equal(store.orders()[0].status,'UNKNOWN');assert.equal(store.get('settings').running,false);assert.equal(store.get('settings').liveArmed,false);
  store.set('settings',{...store.get('settings'),running:true,liveArmed:true});await engine.tick();assert.equal(calls,1);
});
test('team rewards use only the organization member net amount',t=>{
  const {store,engine}=setup(t);store.saveCredentials({key:'k',secret:'s',orgId:'mine'});
  engine.importTeam({id:'team-id',createdTs:'2026-10-26T10:00:00Z',status:'COMPLETED',currencyAlgoTicket:{name:'Team Gold',currencyAlgo:{currency:'BTC'}},
    members:[{organizationId:'mine',addedAmount:.0001,claimed:true,paymentStatus:'OK',rewards:[{coin:'BTC',rewardAmount:.001,rewardFeeAmount:.00001}]},
      {organizationId:'someone-else',addedAmount:1,claimed:true,rewards:[{coin:'BTC',rewardAmount:3,rewardFeeAmount:0}]}],
    orderDetails:{endTs:'2026-10-26T12:00:00Z',soloReward:[{coin:'BTC',depositComplete:true,payoutReward:312500000}]}},{BTC:1});
  assert.equal(store.orders()[0].costBtc,10000);assert.equal(store.rewards().length,1);assert.equal(store.rewards()[0].amount,100000);assert.equal(store.rewards()[0].confirmed,true);
});
test('database lease prevents simultaneous engine ownership',t=>{const {store}=setup(t);assert.equal(store.acquire('a'),true);assert.equal(store.acquire('b'),false);assert.equal(store.owns('a'),true);store.release('a');assert.equal(store.acquire('b'),true);});
test('additional team rewards append deltas and repeated sync never doubles them',t=>{
  const {store,engine}=setup(t);store.saveCredentials({key:'k',secret:'s',orgId:'mine'});
  const raw={id:'team',status:'COMPLETED',currencyAlgoTicket:{name:'Team Gold',currencyAlgo:{currency:'BTC'}},members:[{organizationId:'mine',addedAmount:.0001,claimed:true,paymentStatus:'OK',rewards:[{coin:'BTC',rewardAmount:.001,rewardFeeAmount:0}]}],orderDetails:{soloReward:[{coin:'BTC',depositComplete:true}]}};
  engine.importTeam(raw,{BTC:1});engine.importTeam(raw,{BTC:1});assert.equal(store.rewards().length,1);
  raw.members[0].rewards[0].rewardAmount=.002;engine.importTeam(raw,{BTC:1});engine.importTeam(raw,{BTC:1});
  assert.equal(store.rewards().length,2);assert.equal(store.rewards().reduce((n,r)=>n+r.valueBtc,0),200000);
});
test('starting a store recovers unfinished submissions and disarms live mode',t=>{
  const dir=mkdtempSync(join(tmpdir(),'fp-recovery-test-'));let s=new Store(dir);s.set('settings',{...DEFAULTS,mode:'live',liveArmed:true,running:true});
  s.saveOrder({id:'crash-order',mode:'live',status:'SUBMITTING',createdAt:new Date().toISOString(),costBtc:10000});s.close();
  s=new Store(dir);assert.equal(s.orders()[0].status,'UNKNOWN');assert.equal(s.get('settings').liveArmed,false);assert.equal(s.get('settings').running,false);s.close();rmSync(dir,{recursive:true,force:true});
});
test('unmatched teams are never guessed and tracked costs remain reserved',t=>{
  const {store,engine}=setup(t);store.saveCredentials({key:'k',secret:'s',orgId:'mine'});
  store.saveOrder({id:'tracked',externalId:'team',mode:'live',kind:'team',status:'PENDING',costBtc:30000,feeBtc:300,createdAt:new Date().toISOString()});
  assert.equal(engine.importTeam({id:'team',members:[{organizationId:'someone-else',addedAmount:3}]}),null);
  assert.equal(store.orders()[0].status,'PENDING');assert.ok(store.orders()[0].syncPending);assert.equal(store.orders()[0].costBtc,30000);assert.equal(store.orders()[0].feeBtc,300);assert.equal(store.rewards().length,0);
});
test('organization matching tolerates UUID case differences',t=>{
  const {store,engine}=setup(t);store.saveCredentials({key:'k',secret:'s',orgId:'ABCDEF00-1234-1234-1234-123456789012'});
  const o=engine.importTeam({id:'case-team',status:'WAITING',members:[{organizationId:'abcdef00-1234-1234-1234-123456789012',addedAmount:.0001}]});assert.equal(o.costBtc,10000);
});
test('a tracked purchase absent from the catalogue is still fetched and remains reserved',async t=>{
  const {store,engine}=setup(t);store.set('settings',{...DEFAULTS,mode:'live',running:true,liveArmed:true});
  store.saveOrder({id:'tracked',externalId:'team',mode:'live',kind:'team',status:'PENDING',costBtc:30000,feeBtc:300,createdAt:new Date().toISOString()});
  let calls=0;engine.client=()=>({credentials:{orgId:'mine'},syncClock:async()=>{},balances:async()=>({currencies:[{currency:'BTC',available:'0.02',btcRate:1}]}),pages:async()=>[],ticket:async()=>{calls++;return {id:'team',members:null};}});
  const result=await engine.sync();assert.equal(calls,1);assert.equal(result.historyComplete,false);assert.equal(store.orders()[0].status,'PENDING');assert.ok(store.orders()[0].syncPending);assert.equal(store.orders()[0].costBtc,30000);assert.equal(store.orders()[0].feeBtc,300);assert.equal(store.get('settings').liveArmed,true);assert.equal(store.get('settings').running,true);
});
test('a known team can reconcile after leaving the available package catalogue',async t=>{
  const {store,engine}=setup(t);store.saveCredentials({key:'k',secret:'s',orgId:'mine'});
  store.saveOrder({id:'tracked',externalId:'team',mode:'live',kind:'team',status:'UNKNOWN',costBtc:30000,feeBtc:300,createdAt:new Date().toISOString()});
  engine.client=()=>({credentials:{orgId:'mine'},syncClock:async()=>{},balances:async()=>({currencies:[{currency:'BTC',available:'0.02',btcRate:1}]}),pages:async()=>[],ticket:async()=>({id:'team',status:'CREATED',members:[{organizationId:'mine',addedAmount:.0003}]})});
  const result=await engine.sync();assert.equal(result.historyComplete,true);assert.equal(store.orders()[0].status,'ACTIVE');assert.equal(store.orders()[0].costBtc,30000);
});
test('a provider-confirmed returned contribution releases the reserved net spend',t=>{
  const {store,engine}=setup(t);store.saveCredentials({key:'k',secret:'s',orgId:'mine'});
  store.saveOrder({id:'returned',externalId:'team',mode:'live',kind:'team',status:'UNKNOWN',costBtc:30000,feeBtc:300,createdAt:new Date().toISOString()});
  const o=engine.importTeam({id:'team',status:'DEAD',members:[{organizationId:'mine',addedAmount:0,paymentStatus:'RETURNED'}]});
  assert.equal(o.status,'CANCELLED');assert.equal(o.costBtc,30000);assert.equal(o.refundBtc,30000);assert.equal(o.feeBtc,0);
});
test('a recovered team parses BigDecimal formats, clears stale errors and retains its original identity',t=>{
 const {store,engine}=setup(t);store.saveCredentials({key:'k',secret:'s',orgId:'mine'});
 store.saveOrder({id:'original',externalId:'4f6f9902-63bd-4bea-b216-8ec7839835a4',mode:'live',kind:'team',strategyId:'strategy',requestId:'original-request',status:'UNKNOWN',error:'Team history could not be reconciled',costBtc:10000,feeBtc:100,createdAt:'2026-10-26T10:00:00Z'});
 const raw={id:'4f6f9902-63bd-4bea-b216-8ec7839835a4',status:'COUNTDOWN',currencyAlgoTicket:{name:'Team Gold',currencyAlgo:{currency:'BTC'}},members:[{organizationId:'mine',paymentStatus:'OK',addedAmount:'1.00000000000E-4',rewards:[{coin:'BTC',rewardAmount:'0E-8',rewardFeeAmount:'0.000000000000'}]}]};
 const o=engine.importTeam(raw);assert.equal(o.id,'original');assert.equal(o.status,'PENDING');assert.equal(o.costBtc,10000);assert.equal(o.feeBtc,0);assert.equal(o.requestId,'original-request');assert.equal(o.strategyId,'strategy');assert.equal(o.error,undefined);assert.equal(store.orders().length,1);assert.equal(store.rewards().length,0);
 engine.importTeam(raw);assert.equal(store.orders().length,1);assert.equal(store.rewards().length,0);
});
test('a malformed reward rolls back the team import and preserves the existing cost and buffer',t=>{
 const {store,engine}=setup(t);store.saveCredentials({orgId:'mine'});
 const original={id:'original',externalId:'team',mode:'live',kind:'team',status:'UNKNOWN',costBtc:30000,feeBtc:300,createdAt:new Date().toISOString()};store.saveOrder(original);
 assert.throws(()=>engine.importTeam({id:'team',status:'COMPLETED',members:[{organizationId:'mine',addedAmount:'3E-4',rewards:[{coin:'BTC',rewardAmount:'1E-4'},{coin:'BCH',rewardAmount:'not-an-amount'}]}]}),/team BCH reward.rewardAmount/);
 assert.deepEqual(store.orders()[0],original);assert.equal(store.rewards().length,0);
 assert.throws(()=>engine.importTeam({id:'new-team',status:'COMPLETED',members:[{organizationId:'mine',addedAmount:null}]}),/team member addedAmount/);assert.equal(store.orders().length,1);
});
test('high precision cumulative team rewards append only payable net units without duplicate rounding',t=>{
 const {store,engine}=setup(t);store.saveCredentials({orgId:'mine'});
 const raw={id:'team',status:'COMPLETED',members:[{organizationId:'mine',addedAmount:'1E-4',claimed:true,rewards:[{coin:'BTC',rewardAmount:'2.1E-8',rewardFeeAmount:'9E-9'}]}],orderDetails:{soloReward:[{coin:'BTC',depositComplete:true}]}};
 engine.importTeam(raw);engine.importTeam(raw);assert.equal(store.rewards().length,1);assert.equal(store.rewards()[0].amount,2);assert.equal(store.rewards()[0].valueBtc,2);assert.equal(store.orders()[0].status,'COMPLETED');assert.match(store.orders()[0].rewardPrecisionNote,/rounds/);
 raw.members[0].rewards[0].rewardAmount='3.1E-8';engine.importTeam(raw);engine.importTeam(raw);assert.equal(store.rewards().length,2);assert.equal(store.rewards().reduce((n,r)=>n+r.amount,0),3);
});
