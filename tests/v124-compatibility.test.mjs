import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {NiceHash} from '../server/nicehash.mjs';
import {ManualPurchases} from '../server/manual-purchases.mjs';
import {DEFAULTS,STRATEGY_DEFAULTS,guard} from '../public/core.mjs';
import {Engine as BaselineEngine} from './fixtures/v1.2.4/server/engine.mjs';
import {NiceHash as BaselineApi} from './fixtures/v1.2.4/server/nicehash.mjs';
import {ManualPurchases as BaselineManual} from './fixtures/v1.2.4/server/manual-purchases.mjs';
import {guard as baselineGuard} from './fixtures/v1.2.4/public/core.mjs';

const teamId='c7f74c51-ccb6-4aa0-a19c-3f2f8462a8d8',soloId='44444444-4444-4444-4444-444444444444';
const org='11111111-1111-1111-1111-111111111111';
const credentials={key:'baseline-test-key',secret:'baseline-test-secret',orgId:org};
const primary={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',currency:'LTC',address:'ltc1qbaselineexampledestination000000',organizationId:org};
const merged={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',currency:'DOGE',address:'DBaselineExampleDestination000000',organizationId:org};

// Run the ORIGINAL engine/adapter/manual implementation and the current one
// against separate copies of the same account. Every provider call is mocked;
// no fetch can escape this harness. Assertions compare the actual POST bytes.
async function run(t,baseline,scenario={}){
  const dir=mkdtempSync(join(tmpdir(),'fp-v124-parity-')),store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const EngineType=baseline?BaselineEngine:Engine,ApiType=baseline?BaselineApi:NiceHash,ManualType=baseline?BaselineManual:ManualPurchases;
  const engine=new EngineType(store),manual=new ManualType(engine),team=scenario.team!==false,coin=scenario.coin||'BTC';
  const price=.0001,packageId=team?teamId:soloId,name=team?'Team '+(coin==='BTC'?'Gold':coin==='LTC'?'Palladium':'Silver'):'Gold S';
  const provider={posts:[],privateDetailReads:0,catalogueReads:0,shares:0,errors:[]};
  const rawTeam=()=>({id:teamId,status:'WAITING',state:'OPEN',minShareAmount:price,addedAmount:.0068,
    ...(scenario.oldDeadline?{lifeTimeTill:new Date(Date.now()-60000).toISOString()}:{}),
    members:provider.shares?[{organizationId:org,addedAmount:(provider.shares*price).toFixed(8),paymentStatus:'OK',shares:{small:provider.shares}}]:[],
    currencyAlgoTicket:{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',name,available:true,price:.04,minShareAmount:price,currencyMarket:'BTC',duration:3600,currencyAlgo:{currency:coin,blockRewardWithNhFee:3.125},...(scenario.merge?{mergeCurrencyAlgo:{currency:'DOGE'}}:{})}});
  const api=new ApiType(credentials,async(url,options)=>{
    const u=new URL(url),path=u.pathname,reply=(value,status=200)=>new Response(JSON.stringify(value),{status});
    if(options.headers['X-Auth']){
      const h=options.headers,message=[credentials.key,h['X-Time'],h['X-Nonce'],'',org,'',options.method,path,u.search.slice(1)].join('\0')+(options.body?'\0'+options.body:'');
      assert.equal(h['X-Auth'],credentials.key+':'+createHmac('sha256',credentials.secret).update(message).digest('hex'));
    }
    if(options.method==='POST'){
      provider.posts.push({path,body:options.body,requestId:options.headers['X-Request-Id']});
      if(scenario.timeout)throw new Error('Synthetic lost response');
      if(scenario.reject)return reply({errors:[{code:110,message:'The requested resource was not found'}]},404);
      if(team){assert.equal(path,'/main/api/v2/hashpower/shared/ticket/'+teamId);provider.shares=JSON.parse(options.body).shares.small;return reply({success:true,successType:'SUCCESSFUL'});}
      assert.equal(path,'/main/api/v2/hashpower/solo/order');return reply({id:'55555555-5555-4555-8555-555555555555',amount:price,status:{code:'PENDING'}});
    }
    if(path==='/api/v2/time')return reply({serverTime:Date.now()});
    if(path==='/main/api/v2/accounting/accounts2')return reply({currencies:[{currency:'BTC',available:'.02',btcRate:1}]});
    if(path==='/main/api/v2/hashpower/solo/order')return reply({list:[]});
    if(path==='/main/api/v2/hashpower/solo/shared/order')return reply({list:team?[rawTeam()]:[]});
    if(path==='/main/api/v2/hashpower/solo/shared/order/'+teamId){
      provider.privateDetailReads++;
      if(scenario.unjoinedDetailsMissing&&!provider.shares)return reply({errors:[{code:110,message:'No owned detail before joining'}]},404);
      return reply(rawTeam());
    }
    if(path==='/main/api/v2/hashpower/sharedTicketExternalAddress/list')return reply([primary,merged]);
    if(path==='/main/api/v2/public/solo/package')return reply(team?[]:[{id:soloId,name,available:true,price,currencyMarket:'BTC',duration:3600,currencyAlgo:{currency:coin},...(scenario.merge?{mergeCurrencyAlgo:{currency:'DOGE'}}:{})}]);
    if(path==='/main/api/v2/public/solo/shared/order'){
      provider.catalogueReads++;
      if(scenario.failExtraCatalogue&&provider.catalogueReads>(scenario.manual?2:1))return reply({errors:[{code:1,message:'Extra catalogue read failed'}]},503);
      return reply({list:team?[rawTeam()]:[]});
    }
    if(path==='/main/api/v2/exchangeRate/list')return reply({list:[]});
    throw new Error('Unexpected synthetic provider request: '+options.method+' '+path);
  });
  engine.client=()=>api;
  store.saveCredentials(credentials);store.set('verified',true);
  store.set('settings',{...DEFAULTS,mode:'live',running:!scenario.manual,liveArmed:true,autoSync:false});
  const strategy={...STRATEGY_DEFAULTS,continuous:false,id:'compatibility',name:'Original strategy',enabled:true,mode:team?'team':'solo',kind:team?'team':'interval',coin,packageName:name,
    shares:scenario.shares||1,maxPrice:10000*(scenario.shares||1),budget:1000000,minTeamShares:50,stopOnWin:false,...(scenario.fixed?{packageId}:{}),...(scenario.saved?{payoutAddress:primary.address,mergePayoutAddress:scenario.merge?merged.address:''}:{}),
    ...(scenario.levels?{teamLevels:[{threshold:50,shares:1},{threshold:100,shares:1},{threshold:150,shares:1}]}:{})};
  if(scenario.manual){
    try{const q=await manual.quote({packageId,shares:strategy.shares,payoutAddress:strategy.payoutAddress||'',mergePayoutAddress:strategy.mergePayoutAddress||''});await manual.buy(q.id);}catch(e){provider.errors.push(e.message);}
  }else{
    store.strategy(strategy);try{await engine.tick();}catch(e){provider.errors.push(e.message);}
  }
  return {provider,state:store.state(),engine,store};
}
test('frozen v1.2.4 comparison source matches its recorded commit bytes',()=>{
  const root=new URL('./fixtures/v1.2.4/',import.meta.url),manifest=JSON.parse(readFileSync(new URL('source-manifest.json',root)));
  assert.equal(manifest.commit,'31869544f1b186200f6f207cdce5d004e170ff7d');
  for(const [path,hash] of Object.entries(manifest.files))assert.equal(createHash('sha256').update(readFileSync(new URL(path,root))).digest('hex'),hash,path);
});
for(const scenario of [
  {label:'solo BTC',team:false},{label:'solo BCH',team:false,coin:'BCH'},
  {label:'solo LTC/DOGE with saved addresses',team:false,coin:'LTC',merge:true,saved:true},
  {label:'team BTC'},{label:'three BCH team shares',coin:'BCH',shares:3},
  {label:'fixed team',fixed:true},{label:'team LTC/DOGE with saved addresses',coin:'LTC',merge:true,saved:true},
  {label:'manual team',manual:true,shares:2},{label:'manual merged team with saved addresses',manual:true,coin:'LTC',merge:true,saved:true}
])test('v1.2.4 parity: '+scenario.label,async t=>{
  const old=await run(t,true,scenario),current=await run(t,false,scenario);
  assert.equal(old.provider.posts.length,1,JSON.stringify(old.provider.errors));assert.equal(current.provider.posts.length,1,JSON.stringify(current.provider.errors));
  assert.deepEqual(current.provider.posts.map(({path,body})=>({path,body})),old.provider.posts.map(({path,body})=>({path,body})));
  assert.equal(current.state.orders[0].costBtc,old.state.orders[0].costBtc);assert.equal(current.state.orders[0].status,old.state.orders[0].status);
});
test('v1.2.4 parity: a WAITING/OPEN catalogue team is not vetoed by an additional inferred deadline',async t=>{
  const old=await run(t,true,{oldDeadline:true}),current=await run(t,false,{oldDeadline:true});
  assert.equal(old.provider.posts.length,1);assert.equal(current.provider.posts.length,1,JSON.stringify(current.state.runtime.decisions));
});
test('v1.2.4 parity: a first buying level uses the original join request without requiring an owned-detail GET',async t=>{
  const old=await run(t,true,{levels:true,unjoinedDetailsMissing:true}),current=await run(t,false,{levels:true,unjoinedDetailsMissing:true});
  assert.equal(old.provider.posts.length,1);assert.equal(current.provider.posts.length,1,JSON.stringify(current.provider.errors));
  assert.equal(current.provider.privateDetailReads,0);assert.equal(current.provider.posts[0].body,old.provider.posts[0].body);
});
for(const manual of [false,true])test('v1.2.4 parity: '+(manual?'manual':'strategy')+' buying does not depend on extra catalogue reads',async t=>{
  const old=await run(t,true,{manual,failExtraCatalogue:true}),current=await run(t,false,{manual,failExtraCatalogue:true});
  assert.equal(old.provider.posts.length,1);assert.equal(current.provider.posts.length,1,JSON.stringify(current.provider.errors));
  assert.equal(current.provider.catalogueReads,old.provider.catalogueReads);
});
test('v1.2.4 parity: financial and uncertainty guards retain their original decisions for legacy strategies',()=>{
  const now=Date.parse('2026-10-27T12:00:00Z'),q={id:teamId,coin:'BTC',name:'Team Gold',team:true,market:'BTC',available:true,costBtc:10000,teamShares:68,quotedAt:new Date(now).toISOString()};
  const strategy={...STRATEGY_DEFAULTS,continuous:false,id:'s',mode:'team',enabled:true,stopOnWin:false},base={settings:{...DEFAULTS,mode:'live',running:true,liveArmed:true},orders:[],rewards:[],runtime:{lastSync:new Date(now).toISOString(),balance:2000000,historyComplete:true}};
  const entry=extra=>({id:'owned',mode:'live',kind:'team',status:'COMPLETED',costBtc:10000,createdAt:new Date(now).toISOString(),...extra});
  for(const [label,amend,expected] of [
    ['eligible',()=>{},null],['engine pause',s=>s.settings.running=false,'Engine is paused'],['strategy pause',(s,b)=>b.enabled=false,'Strategy is paused'],
    ['ownership',s=>s.orders.push(entry({attribution:{state:'review'}})),'Imported purchase ownership is being verified; account sync will retry'],
    ['circuit breaker',s=>s.runtime.errors=3,'API error circuit breaker'],['uncertain',s=>s.orders.push(entry({status:'UNKNOWN'})),'Unresolved purchase: reconcile before buying'],
    ['arming',s=>s.settings.liveArmed=false,'Live buying is not armed'],['pending sync',s=>s.orders.push(entry({syncPending:{reason:'test'}})),'Waiting for NiceHash order details; account sync will retry'],
    ['history',s=>s.runtime.historyComplete=false,'Account history is incomplete; review sync warnings before buying'],['stale balance',s=>s.runtime.lastSync='2026-10-27T11:00:00Z','Account data is stale'],
    ['schedule',s=>{s.settings.startHour='00:00';s.settings.endHour='00:00';},'Outside buying schedule'],['availability',(s,b,p)=>p.available=false,'Package unavailable'],
    ['rejected target',s=>s.orders.push(entry({packageId:teamId,status:'FAILED',submissionFailure:{rejected:true,httpStatus:404,path:'/main/api/v2/hashpower/shared/ticket/'+teamId}})),'This team lobby was rejected as unavailable; choose a current matching team'],
    ['stale quote',(s,b,p)=>p.quotedAt='2026-10-27T11:00:00Z','Package quote is stale'],['currency',(s,b,p)=>p.market='USDT','Version 1 buys BTC-priced packages only'],
    ['invalid price',(s,b,p)=>p.costBtc=0,'Invalid package price'],['price ceiling',(s,b,p)=>p.costBtc=10001,'Price exceeds purchase ceiling'],['per-order reserve',s=>s.settings.maxOrder=10000,'Price exceeds purchase ceiling'],
    ['purchase limit',(s,b)=>{b.maxPurchases=1;s.orders.push(entry({strategyId:'s'}));},'Purchase count reached'],
    ['strategy budget',(s,b)=>{b.budget=10000;s.orders.push(entry({strategyId:'s'}));},'Strategy budget reached'],
    ['concurrency',s=>{s.settings.maxActive=1;s.orders.push(entry({status:'ACTIVE'}));},'Concurrent package limit'],
    ['daily cap',s=>s.orders.push(entry({costBtc:95000})),'Daily spending cap'],
    ['weekly cap',s=>s.orders.push(entry({costBtc:495000,createdAt:'2026-10-26T10:00:00Z'})),'Weekly spending cap'],
    ['monthly cap',s=>s.orders.push(entry({costBtc:1495000,createdAt:'2026-10-19T10:00:00Z'})),'Monthly spending cap'],
    ['stop loss',s=>s.orders.push(entry({costBtc:400000,createdAt:'2026-09-20T10:00:00Z'})),'Stop loss reached'],
    ['take profit',s=>{s.orders.push(entry({costBtc:0}));s.rewards.push({orderId:'owned',coin:'BTC',confirmed:true,amount:1100000,valueBtc:1100000,createdAt:new Date(now).toISOString()});},'Take profit reached'],
    ['unpriced reward',s=>{s.orders.push(entry());s.rewards.push({orderId:'owned',coin:'BCH',confirmed:true,amount:1,valueBtc:null,createdAt:new Date(now).toISOString()});},'Unvalued confirmed rewards: reconcile accounting'],
    ['reserve',s=>s.runtime.balance=0,'Minimum wallet reserve'],['interval',(s,b)=>b.lastBuyAt=new Date(now).toISOString(),'Waiting for next interval'],
    ['stop on win',(s,b)=>{b.stopOnWin=true;s.orders.push(entry({strategyId:'s'}));s.rewards.push({orderId:'owned',confirmed:true,coin:'BTC',amount:1,valueBtc:1,createdAt:new Date(now).toISOString()});},'Stopped after a confirmed reward'],
    ['odds',(s,b,p)=>{b.kind='odds';b.maxOdds=100;p.odds=200;},'Probability threshold not met'],
    ['share threshold',(s,b,p)=>p.teamShares=49,'Waiting for team share threshold'],
    ['existing membership',s=>s.orders.push(entry({packageId:teamId,status:'PENDING'})),'Already joined this team']
  ]){
    const state=structuredClone(base),s=structuredClone(strategy),quote={...q};amend(state,s,quote);
    assert.equal(baselineGuard(state,s,quote,now),expected,'baseline: '+label);
    assert.equal(guard(state,s,quote,now),label==='currency'?'Package payment market does not match the strategy':expected,'current: '+label);
  }
});
for(const scenario of [{label:'confirmed rejection',reject:true},{label:'uncertain response',timeout:true}])test('v1.2.4 parity: '+scenario.label+' never replays a POST',async t=>{
  const old=await run(t,true,scenario),current=await run(t,false,scenario);
  assert.equal(old.provider.posts.length,1);assert.equal(current.provider.posts.length,1);assert.equal(current.state.orders[0].status,old.state.orders[0].status);assert.equal(current.state.orders[0].feeBtc,old.state.orders[0].feeBtc);
  for(const app of [old,current]){app.store.set('settings',{...app.store.get('settings'),running:true,liveArmed:true});await app.engine.tick();assert.equal(app.provider.posts.length,1);}
});
