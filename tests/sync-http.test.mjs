import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {Store} from '../server/store.mjs';
async function start(t,scenario){
  const dir=mkdtempSync(join(tmpdir(),'fp-sync-http-')),password='synthetic-admin-password';
  if(scenario==='level-uncertain'){
    const store=new Store(dir),when=new Date().toISOString(),externalId='01d3cfea-5296-4688-be94-c3cffb55fc83';
    store.saveOrder({id:'level-owned',mode:'live',kind:'team',strategyId:'levels',externalId,packageId:externalId,status:'UNKNOWN',shares:2,costBtc:20000,feeBtc:100,createdAt:when,
      teamBuys:[{threshold:50,shares:1,amountBtc:10000,status:'CONFIRMED',requestId:'first',createdAt:when},{threshold:100,shares:1,amountBtc:10000,status:'UNKNOWN',requestId:'second',createdAt:when}],
      pendingTeamPurchase:{requestId:'second',targetCostBtc:20000,targetShares:2,before:{costBtc:10000,feeBtc:0,shares:1,status:'PENDING',spendHistory:[{at:when,amountBtc:10000}]}}});store.close();
  }
  if(['purchase-route-team','purchase-route-solo'].includes(scenario)){
    const store=new Store(dir);store.set('settings',{...store.get('settings'),mode:'live'});store.close();
  }
  if(scenario==='rejected-team'){
    const store=new Store(dir),id='6bc903de-f736-4add-a1fc-436dd5cd2b89';
    store.set('settings',{...store.get('settings'),mode:'live'});
    store.saveOrder({id:'rejected-team-attempt',externalId:id,packageId:id,requestId:'rejected-request',mode:'live',kind:'team',status:'FAILED',costBtc:10000,feeBtc:100,createdAt:'2026-10-26T19:26:00Z',source:'Strategy engine',error:'NiceHash rejected POST /main/api/v2/hashpower/shared/ticket/'+id+' (HTTP 404, code 110).',syncPending:{reason:'Waiting for team membership'}});store.close();
  }
  if(['team-decimals','team-invalid-amount'].includes(scenario)){
    const store=new Store(dir);store.saveOrder({id:'original-team-entry',externalId:'4f6f9902-63bd-4bea-b216-8ec7839835a4',mode:'live',kind:'team',status:'UNKNOWN',costBtc:10000,feeBtc:100,createdAt:'2026-10-26T10:00:00Z',error:'Team history could not be reconciled',source:'Manual web purchase'});store.close();
  }
  if(['team-embedded','team-unattributed'].includes(scenario)){
    const store=new Store(dir);store.set('settings',{...store.get('settings'),mode:'live'});
    store.saveOrder({id:'legacy-whole-team',externalId:'4a0f6fc4-d8df-4d7f-b2cc-7a4bb747f5cc',mode:'live',kind:'solo',status:'COMPLETED',coin:'BCH',name:'BCH imported',source:'NiceHash import',costBtc:403300,feeBtc:0,refundBtc:0,createdAt:'2026-10-25T15:51:00Z'});
    store.reward({id:'legacy-whole-payout',orderId:'legacy-whole-team',coin:'BCH',amount:303133399,valueBtc:1046637,confirmed:true,createdAt:'2026-10-25T15:51:00Z'});store.close();
  }
  const child=spawn(process.execPath,['--import',fileURLToPath(new URL('./fixtures/nicehash-mock.mjs',import.meta.url)),'server/main.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'0',HOST:'127.0.0.1',PUBLIC_URL:'',DATA_DIR:dir,APP_PASSWORD:password,
    NICEHASH_CONFIG_FILE:'',NICEHASH_API_KEY:'mock-key',NICEHASH_API_SECRET:'mock-secret',NICEHASH_ORGANIZATION_ID:'11111111-1111-1111-1111-111111111111',NICEHASH_BASE_URL:'https://api2.nicehash.com',FP_TEST_SCENARIO:scenario},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}rmSync(dir,{force:true,recursive:true});});
  const base=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('Server startup timeout')),5000);child.stdout.on('data',b=>{output+=b;const m=output.match(/http:\/\/127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);resolve(m[0]);}});child.on('error',reject);});
  let cookie='';const call=(path,method='GET',body)=>fetch(base+path,{method,headers:{Origin:base,Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const login=await call('/api/auth/login','POST',{password});cookie=login.headers.get('set-cookie').split(';')[0];return {call,password};
}
test('Test & Sync provider-401 preserves the authenticated dashboard session',async t=>{
  const {call}=await start(t,'provider-401');const response=await call('/api/sync','POST',{}),failure=await response.json();
  assert.equal(response.status,502);assert.equal(failure.code,'NICEHASH_API_ERROR');assert.equal(failure.provider.httpStatus,401);assert.equal(failure.provider.code,2000);
  assert.equal((await call('/api/state')).status,200);assert.equal((await (await call('/api/auth/status')).json()).authenticated,true);
  const state=await (await call('/api/state')).json();assert.equal(state.connection.verified,false);assert.equal(state.runtime.lastErrorDetails.httpStatus,401);
  assert.ok(!JSON.stringify(state).includes('mock-secret'));assert.ok(!JSON.stringify(failure).includes('mock-secret'));
});
test('unjoined catalogue teams do not block live arming or fabricate costs',async t=>{
  const {call,password}=await start(t,'missing-member');const response=await call('/api/sync','POST',{}),result=await response.json();
  assert.equal(response.status,200);assert.equal(result.balance,2000000);assert.equal(result.historyComplete,true);assert.equal(result.teams,0);assert.equal(result.warnings.length,0);assert.equal(result.catalogueTeamsSkipped,1);
  const state=await (await call('/api/state')).json();assert.equal(state.connection.verified,true);assert.equal(state.runtime.historyComplete,true);assert.equal(state.orders.length,0);
  assert.equal((await (await call('/api/auth/status')).json()).authenticated,true);
  const arm=await call('/api/arm','POST',{password,confirm:'ENABLE LIVE BUYING'});assert.equal(arm.status,200);
  const after=await (await call('/api/state')).json();assert.equal(after.settings.liveArmed,true);assert.equal(after.settings.running,false);
});
test('an upgraded rejected team attempt recovers through HTTP sync and allows explicit arming',async t=>{
  const {call,password}=await start(t,'rejected-team');
  let state=await (await call('/api/state')).json(),o=state.orders[0];
  assert.equal(o.externalId,null);assert.equal(o.attemptedTeamId,'6bc903de-f736-4add-a1fc-436dd5cd2b89');assert.equal(o.status,'FAILED');assert.equal(o.feeBtc,0);assert.equal(o.syncPending,undefined);
  assert.equal(state.settings.liveArmed,false);assert.equal(state.settings.running,false);
  const sync=await call('/api/sync','POST',{}),result=await sync.json();
  assert.equal(sync.status,200);assert.equal(result.historyComplete,true);assert.equal(result.warnings.length,0);assert.equal(result.catalogueTeamsSkipped,1);
  assert.equal((await call('/api/arm','POST',{password,confirm:'ENABLE LIVE BUYING'})).status,200);
  state=await (await call('/api/state')).json();assert.equal(state.connection.verified,true);assert.equal(state.settings.liveArmed,true);assert.equal(state.settings.running,false);assert.equal(state.orders.length,1);assert.equal(state.orders[0].externalId,null);
  assert.equal((await (await call('/api/auth/status')).json()).authenticated,true);
});
test('the four reported catalogue IDs plus six USDT entries allow BTC arming',async t=>{
  const {call,password}=await start(t,'catalogue-and-usdt');const result=await (await call('/api/sync','POST',{})).json();
  assert.equal(result.catalogueTeamsSkipped,4);assert.equal(result.ignoredUsdt,6);assert.equal(result.historyComplete,true);assert.equal(result.warnings.length,0);
  assert.equal((await call('/api/arm','POST',{password,confirm:'ENABLE LIVE BUYING'})).status,200);
  const state=await (await call('/api/state')).json();assert.equal(state.orders.length,0);assert.equal(state.settings.liveArmed,true);assert.equal(state.settings.running,false);
});
test('personal spending with redacted member identity still blocks live buying',async t=>{
  const {call,password}=await start(t,'redacted-member');const result=await (await call('/api/sync','POST',{})).json();
  assert.equal(result.historyComplete,false);assert.equal(result.warnings.length,1);assert.equal((await call('/api/arm','POST',{password,confirm:'ENABLE LIVE BUYING'})).status,409);
});
test('a joined team imports only the matching organization contribution',async t=>{
  const {call}=await start(t,'owned-member');const result=await (await call('/api/sync','POST',{})).json();assert.equal(result.historyComplete,true);assert.equal(result.teams,1);
  const state=await (await call('/api/state')).json();assert.equal(state.orders.length,1);assert.equal(state.orders[0].costBtc,10000);
});
test('existing snake_case JSON and server-environment selection both sync successfully',async t=>{
  const {call}=await start(t,'success');const save=await call('/api/connection','POST',{nicehash:{api_key:'${NICEHASH_API_KEY}',api_secret:'${NICEHASH_API_SECRET}',organization_id:'${NICEHASH_ORGANIZATION_ID}',base_url:'https://api2.nicehash.com'}});
  assert.equal(save.status,200);assert.equal((await call('/api/sync','POST',{})).status,200);
  let state=await (await call('/api/state')).json();assert.equal(state.connection.source,'web');assert.equal(state.connection.verified,true);
  assert.equal((await call('/api/connection/server','POST',{})).status,200);assert.equal((await call('/api/sync','POST',{})).status,200);
  state=await (await call('/api/state')).json();assert.equal(state.connection.source,'server');assert.equal(state.runtime.historyComplete,true);
  const backup=await (await call('/api/export')).text();assert.ok(!backup.includes('mock-secret'));assert.ok(!backup.includes('mock-key'));
});
test('manual purchase HTTP flow preserves destinations and exports coin/fiat columns without provider buying',async t=>{
 const {call}=await start(t,'manual');
 const saved=await (await call('/api/payout-addresses')).json();assert.equal(saved.addresses[0].currency,'LTC');
 const quote=await (await call('/api/purchases/quote','POST',{packageId:'44444444-4444-4444-4444-444444444444',shares:1,payoutAddress:'ltc1qmockdestination00000000',mergePayoutAddress:'DMockDestination0000000000'})).json();
 assert.equal(quote.coin,'LTC');assert.equal(quote.mergeCoin,'DOGE');assert.equal(quote.costBtc,10000);
 const result=await (await call('/api/purchases','POST',{quoteId:quote.id,costBtc:1,shares:100})).json();assert.equal(result.order.costBtc,10000);assert.equal(result.order.mode,'paper');assert.equal(result.order.shares,1);assert.equal(result.order.payoutAddress,'ltc1qmockdestination00000000');
 const replay=await (await call('/api/purchases','POST',{quoteId:quote.id})).json();assert.equal(replay.replayed,true);assert.equal(replay.order.id,result.order.id);
 const state=await (await call('/api/state')).json();assert.equal(state.orders.length,1);assert.equal(state.settings.running,false);assert.equal(state.runtime.exchangeRates.fiat.EUR.BTC,88000);
 const csv=await (await call('/api/export?format=csv')).text();assert.ok(csv.includes('Current USD estimate'));assert.ok(csv.includes('Current EUR estimate'));assert.ok(csv.includes('"DOGE"'));assert.ok(csv.includes('Merged payout address'));
});
for(const team of [true,false])test('HTTP live '+(team?'team':'solo')+' review signs the documented REST route and submits only once',async t=>{
 const {call,password}=await start(t,team?'purchase-route-team':'purchase-route-solo');
 assert.equal((await call('/api/sync','POST',{})).status,200);assert.equal((await call('/api/arm','POST',{password,confirm:'ENABLE LIVE BUYING'})).status,200);
 const response=await call('/api/purchases/quote','POST',{packageId:team?'01d3cfea-5296-4688-be94-c3cffb55fc83':'44444444-4444-4444-4444-444444444444',shares:team?2:1}),quote=await response.json();assert.equal(response.status,200);
 const bought=await call('/api/purchases','POST',{quoteId:quote.id}),result=await bought.json();assert.equal(bought.status,200);assert.equal(result.order.status,'PENDING');assert.equal(result.order.kind,team?'team':'solo');assert.equal(result.order.costBtc,team?20000:10000);assert.equal(result.order.feeBtc,0);
 const replay=await (await call('/api/purchases','POST',{quoteId:quote.id})).json();assert.equal(replay.replayed,true);assert.equal(replay.order.id,result.order.id);assert.equal(replay.order.status,'PENDING');
 const state=await (await call('/api/state')).json();assert.equal(state.orders.length,1);assert.equal(state.runtime.balance,2000000-result.order.costBtc);assert.equal(state.runtime.historyComplete,true);assert.equal(state.settings.running,false);assert.equal(state.settings.liveArmed,true);
});
test('HTTP export/import round trip restores settings and strategies without replacing ledger or login',async t=>{
 const {call}=await start(t,'manual');
 assert.equal((await call('/api/settings','POST',{reserve:150000,autoSync:false,accountSyncSeconds:93,timezone:'UTC',displayCurrency:'EUR'})).status,200);
 const saved=await (await call('/api/strategies','POST',{name:'Restore this strategy',enabled:true,maxPrice:10000,budget:50000,payoutAddress:'bc1qmockdestination000000000000'})).json();
 const quote=await (await call('/api/purchases/quote','POST',{packageId:'44444444-4444-4444-4444-444444444444',shares:1})).json();
 assert.equal((await call('/api/purchases','POST',{quoteId:quote.id})).status,200);
 const compactResponse=await call('/api/export?format=settings'),compact=await compactResponse.json();assert.match(compactResponse.headers.get('content-disposition'),/easymining-settings.json/);assert.equal(compact.orders,undefined);assert.equal(compact.connection,undefined);assert.equal(compact.schemaVersion,1);
 const backup=await (await call('/api/export')).json(),before=await (await call('/api/state')).json();
 assert.equal(backup.orders.length,1);assert.equal(backup.strategies[0].id,saved.id);
 await call('/api/settings','POST',{reserve:200000,accountSyncSeconds:120});await call('/api/strategies','POST',{...backup.strategies[0],name:'Edited'});
 for(const file of [backup,compact]){
   const response=await call('/api/import','POST',{backup:file,options:{restoreSettings:true,restoreStrategies:true,strategyMode:'merge'}});assert.equal(response.status,200);assert.equal((await response.json()).importedStrategies,1);
   const after=await (await call('/api/state')).json();assert.deepEqual(after.settings,backup.settings);assert.equal(after.strategies.length,1);assert.equal(after.strategies[0].id,saved.id);assert.equal(after.strategies[0].name,'Restore this strategy');assert.equal(after.strategies[0].enabled,false);assert.deepEqual(after.orders,before.orders);assert.deepEqual(after.rewards,before.rewards);assert.deepEqual(after.connection,before.connection);
 }
 const invalid=await call('/api/import','POST',{backup:{settings:{...compact.settings,reserve:123},strategies:[...compact.strategies,{name:'Invalid',budget:0}]}});assert.equal(invalid.status,400);
 assert.deepEqual((await (await call('/api/state')).json()).settings,backup.settings);assert.equal((await (await call('/api/auth/status')).json()).authenticated,true);
});
test('HTTP strategy levels save, validate, export, import and preserve completed paper progress',async t=>{
 const {call}=await start(t,'levels-paper'),teamLevels=[{threshold:50,shares:1},{threshold:100,shares:1},{threshold:150,shares:1}];
 const saved=await call('/api/strategies','POST',{name:'BCH levels',coin:'BCH',packageName:'Team Silver',mode:'team',kind:'team',enabled:true,stopOnWin:false,intervalMinutes:1,minTeamShares:99999,maxPrice:10000,budget:100000,teamLevels}),s=await saved.json();assert.equal(saved.status,200);
 assert.equal((await call('/api/settings','POST',{running:true})).status,200);assert.equal((await call('/api/tick','POST',{})).status,200);
 let state=await (await call('/api/state')).json();assert.deepEqual(state.strategies[0].teamLevels,teamLevels);assert.equal(state.orders.length,1);assert.equal(state.orders[0].teamBuys[0].threshold,50);
 const invalid=await call('/api/strategies','POST',{...state.strategies[0],teamLevels:[{threshold:50,shares:1},{threshold:50,shares:1}]});assert.equal(invalid.status,400);
 const backup=await (await call('/api/export?format=settings')).json();assert.deepEqual(backup.strategies[0].teamLevels,teamLevels);
 assert.equal((await call('/api/import','POST',{backup,options:{restoreSettings:true,restoreStrategies:true,strategyMode:'merge'}})).status,200);
 state=await (await call('/api/state')).json();assert.equal(state.orders.length,1);assert.equal(state.orders[0].teamBuys.length,1);assert.equal(state.strategies[0].enabled,false);assert.equal(state.settings.running,false);
 const csv=await (await call('/api/export?format=csv&mode=paper')).text();assert.match(csv,/Team buying level audit/);assert.match(csv,/already included in order totals/);
 assert.equal((await call('/api/strategies','POST',{...state.strategies[0],enabled:true})).status,200);assert.equal((await call('/api/settings','POST',{running:true})).status,200);assert.equal((await call('/api/tick','POST',{})).status,200);
 state=await (await call('/api/state')).json();assert.equal(state.orders.length,1);assert.equal(state.orders[0].teamBuys.length,1);
});
test('HTTP reconciliation of an uncharged level cannot erase the earlier owned team',async t=>{
 const {call,password}=await start(t,'level-uncertain'),note='Verified provider history: the last addition was not charged';
 assert.equal((await call('/api/reconcile','POST',{id:'level-owned',confirm:'VERIFIED NO PURCHASE',password,note})).status,400);
 assert.equal((await call('/api/reconcile','POST',{id:'level-owned',action:'final-debit',costBtc:0,refundBtc:0,password,note})).status,400);
 assert.equal((await call('/api/reconcile','POST',{id:'level-owned',confirm:'VERIFIED NO ADDITION',password:'wrong',note})).status,400);
 assert.equal((await (await call('/api/state')).json()).orders[0].costBtc,20000);
 assert.equal((await call('/api/reconcile','POST',{id:'level-owned',confirm:'VERIFIED NO ADDITION',password,note})).status,200);
 const state=await (await call('/api/state')).json(),o=state.orders[0];assert.equal(o.costBtc,10000);assert.equal(o.shares,1);assert.equal(o.status,'PENDING');assert.equal(o.externalId,'01d3cfea-5296-4688-be94-c3cffb55fc83');assert.equal(o.pendingTeamPurchase,undefined);assert.equal(o.teamBuys[1].status,'REJECTED');assert.equal(state.settings.running,false);assert.equal(state.settings.liveArmed,false);
});
test('reported team ID with scientific decimals and four USDT entries reconciles and permits live arming',async t=>{
 const {call,password}=await start(t,'team-decimals'),sync=await call('/api/sync','POST',{}),result=await sync.json();
 assert.equal(sync.status,200);assert.equal(result.historyComplete,true);assert.equal(result.ignoredUsdt,4);assert.equal(result.warnings.length,0);
 let state=await (await call('/api/state')).json();assert.equal(state.orders.length,1);assert.equal(state.orders[0].id,'original-team-entry');assert.equal(state.orders[0].costBtc,10000);assert.equal(state.orders[0].feeBtc,0);assert.equal(state.orders[0].status,'PENDING');assert.equal(state.orders[0].error,undefined);
 assert.equal((await call('/api/arm','POST',{password,confirm:'ENABLE LIVE BUYING'})).status,200);
 state=await (await call('/api/state')).json();assert.equal(state.settings.liveArmed,true);assert.equal(state.settings.running,false);assert.equal(state.orders.length,1);
});
test('missing team cost preserves the reservation and exposes the exact field instead of a generic decimal warning',async t=>{
 const {call,password}=await start(t,'team-invalid-amount'),result=await (await call('/api/sync','POST',{})).json();
 assert.equal(result.historyComplete,false);assert.equal(result.ignoredUsdt,4);assert.equal(result.warnings[0].field,'team member addedAmount');assert.match(result.warnings[0].reason,/missing or invalid decimal amount/);
 const state=await (await call('/api/state')).json();assert.equal(state.orders[0].status,'UNKNOWN');assert.equal(state.orders[0].costBtc,10000);assert.equal(state.orders[0].feeBtc,100);
 const arm=await call('/api/arm','POST',{password,confirm:'ENABLE LIVE BUYING'}),failure=await arm.json();
 assert.equal(arm.status,409);assert.equal(failure.code,'HISTORY_INCOMPLETE');assert.equal(failure.warningCount,1);assert.equal(failure.warnings[0].field,'team member addedAmount');assert.match(failure.error,/team member addedAmount/);assert.match(failure.error,/4f6f9902-63bd-4bea-b216-8ec7839835a4/);assert.match(failure.error,/retry automatically/);assert.equal((await call('/api/state')).status,200);
});
test('the server automatically imports an outside purchase while paused without Test & sync or re-arming',async t=>{
 const {call}=await start(t,'auto-external');let state;
 const deadline=Date.now()+6500;
 do{state=await (await call('/api/state')).json();if(state.orders.length)break;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<deadline);
 assert.equal(state.orders.length,1);assert.equal(state.orders[0].externalId,'55555555-5555-5555-5555-555555555555');assert.equal(state.orders[0].costBtc,10000);assert.equal(state.connection.verified,true);assert.equal(state.runtime.historyComplete,true);assert.equal(state.settings.running,false);assert.equal(state.settings.liveArmed,false);
 assert.equal((await (await call('/api/auth/status')).json()).authenticated,true);
});
test('HTTP sync of the 10/41 BCH team imports a personal payout and exports the allocation',async t=>{
 const {call}=await start(t,'team-reward-shares');assert.equal((await call('/api/sync','POST',{})).status,200);
 const state=await (await call('/api/state')).json();assert.equal(state.orders.length,1);assert.equal(state.orders[0].kind,'team');assert.equal(state.orders[0].shares,10);assert.equal(state.orders[0].costBtc,100000);
 assert.equal(state.orders[0].rewardEstimate.totalShares,41);assert.equal(state.orders[0].rewardEstimate.blocks[0].fullAmount,312500000);assert.equal(state.orders[0].rewardEstimate.blocks[0].amount,76219512);
 assert.equal(state.rewards.length,1);assert.equal(state.rewards[0].amount,76219512);assert.equal(state.rewards[0].confirmed,true);assert.equal(state.rewards[0].scope,'team-member');
 const csv=await (await call('/api/export?format=csv&mode=live')).text();assert.match(csv,/Total team shares/);assert.match(csv,/24\.39024390/);assert.match(csv,/0\.76219512/);assert.ok(!csv.includes('"3.12500000"'));
 assert.equal((await call('/api/sync','POST',{})).status,200);assert.equal((await (await call('/api/state')).json()).rewards.length,1);
});
test('upgraded server repairs the reported embedded team and removes the old whole-block amount from financial CSV',async t=>{
 const {call}=await start(t,'team-embedded');let state=await (await call('/api/state')).json();assert.equal(state.orders[0].attribution.state,'review');
 const before=await (await call('/api/export?format=csv&mode=live')).text();assert.match(before,/Excluded from financial report/);assert.ok(!before.includes('"3.03133399"'));
 const sync=await (await call('/api/sync','POST',{})).json();assert.equal(sync.historyComplete,true);
 state=await (await call('/api/state')).json();assert.equal(state.orders.filter(o=>!o.supersededBy).length,1);
 const o=state.orders.find(o=>!o.supersededBy);assert.equal(o.kind,'team');assert.equal(o.status,'COMPLETED');assert.equal(o.shares,10);assert.equal(o.costBtc,100000);assert.equal(o.rewardEstimate.totalShares,41);
 assert.equal(state.rewards.find(r=>r.orderId===o.id).amount,73934975);assert.equal(state.rewards.find(r=>r.id==='legacy-whole-payout').amount,303133399);
 const csv=await (await call('/api/export?format=csv&mode=live')).text();assert.match(csv,/0\.73934975/);assert.ok(!csv.includes('"3.03133399"'));assert.ok(!csv.includes('"0.00403300"'));
 assert.equal((await (await call('/api/auth/status')).json()).authenticated,true);
});
test('upgraded server excludes a shared payout without membership evidence and keeps the dashboard session',async t=>{
 const {call}=await start(t,'team-unattributed');const result=await (await call('/api/sync','POST',{})).json();assert.equal(result.historyComplete,false);
 const state=await (await call('/api/state')).json();assert.equal(state.orders[0].attribution.state,'review');assert.equal(state.rewards[0].amount,303133399);
 const csv=await (await call('/api/export?format=csv&mode=live')).text();assert.match(csv,/Excluded from financial report/);assert.ok(!csv.includes('"3.03133399"'));
 assert.equal((await (await call('/api/auth/status')).json()).authenticated,true);
});
