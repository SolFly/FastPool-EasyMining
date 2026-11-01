import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {NiceHash} from '../server/nicehash.mjs';
import {DEFAULTS,STRATEGY_DEFAULTS,validateStrategy,guard,pickQuote,totals,spendEntries} from '../public/core.mjs';
import {configurationBackup,prepareConfigurationImport} from '../public/config-backup.mjs';
import {DemoApi} from '../public/demo.mjs';
import {resolveUnboughtLevel} from '../server/team-levels.mjs';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',org='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const levels=[{threshold:50,shares:1},{threshold:100,shares:1},{threshold:150,shares:1}];
const strategy=extra=>({id:'levels',...validateStrategy({...STRATEGY_DEFAULTS,continuous:false,id:'levels',name:'BTC levels',coin:'BTC',packageName:'Team Gold',kind:'team',mode:'team',enabled:true,teamLevels:levels,intervalMinutes:1,maxPurchases:20,maxPrice:100000,budget:1000000,stopOnWin:false,...extra})});
function setup(t,settings={}){
 const dir=mkdtempSync(join(tmpdir(),'fp-team-levels-')),ctx={store:new Store(dir),provider:{shares:0,total:50,posts:[],outcome:'ok',rewards:[],claimed:false,state:'OPEN',coupons:0}};
 const c={key:'test-key',secret:'test-secret',orgId:org};ctx.store.saveCredentials(c);ctx.store.set('verified',true);ctx.store.set('settings',{...DEFAULTS,mode:'live',liveArmed:true,running:true,feeBufferBps:0,maxActive:1,...settings});ctx.store.strategy(strategy());
 const raw=(personal=true)=>({id,status:ctx.provider.completed?'COMPLETED':'WAITING',state:ctx.provider.state,minShareAmount:.0001,addedAmount:(ctx.provider.total*.0001).toFixed(8),
  currencyAlgoTicket:{name:'Team Gold',available:true,currencyMarket:'BTC',minShareAmount:.0001,price:.02,duration:3600,currencyAlgo:{currency:'BTC',blockRewardWithNhFee:3.125}},
  ...(personal?{members:ctx.provider.shares?[{organizationId:org,addedAmount:(ctx.provider.shares*.0001).toFixed(8),shares:{small:ctx.provider.shares,couponSmall:ctx.provider.coupons},paymentStatus:'OK',claimed:ctx.provider.claimed,rewards:ctx.provider.rewards}]:[]}:{}),orderDetails:{soloReward:ctx.provider.completed?[{coin:'BTC',depositComplete:true}]:[]}});
 ctx.api=new NiceHash(c,async(url,o)=>{
  const path=new URL(url).pathname,p=ctx.provider,reply=data=>new Response(JSON.stringify(data));
  if(o.method==='POST'){
   assert.equal(path,'/main/api/v2/hashpower/shared/ticket/'+id);const h=o.headers,msg=[c.key,h['X-Time'],h['X-Nonce'],'',org,'','POST',path,''].join('\0')+'\0'+o.body;
   assert.equal(h['X-Auth'],c.key+':'+createHmac('sha256',c.secret).update(msg).digest('hex'));
   const body=JSON.parse(o.body);p.posts.push({body,requestId:h['X-Request-Id']});
   assert.equal(body.clear,false);assert.equal(Math.round(body.amount*100000000),body.shares.small*10000);assert.ok(body.shares.small>p.shares);
   if(p.outcome==='404')return new Response('{"errors":[{"code":110,"message":"The requested resource was not found"}]}',{status:404});
   if(p.outcome==='timeout-before')throw new Error('lost response before provider effect');
   if(p.outcome!=='delayed'){p.total+=body.shares.small-p.shares;p.shares=body.shares.small;}
   if(p.outcome==='timeout-after')throw new Error('lost response after provider effect');
   return reply({success:true,successType:'SUCCESSFUL'});
  }
  if(path==='/api/v2/time')return reply({serverTime:Date.now()});
  if(path==='/main/api/v2/accounting/accounts2')return reply({currencies:[{currency:'BTC',available:(.02-p.shares*.0001).toFixed(8),btcRate:1}]});
  if(path==='/main/api/v2/hashpower/solo/order')return reply({list:[]});
  if(path==='/main/api/v2/hashpower/solo/shared/order')return reply({list:[raw()]});
  if(path==='/main/api/v2/hashpower/solo/shared/order/'+id)return reply(raw());
  if(path==='/main/api/v2/public/solo/package')return reply([]);
  if(path==='/main/api/v2/public/solo/shared/order')return reply({list:[raw(false)]});
  if(path==='/main/api/v2/exchangeRate/list')return reply({list:[]});
  throw new Error('Unexpected synthetic request '+path);
 });
 const engine=()=>{ctx.engine=new Engine(ctx.store);ctx.engine.client=()=>ctx.api;};engine();
 ctx.due=()=>{const s=ctx.store.strategies()[0];s.lastBuyAt=new Date(Date.now()-61000).toISOString();ctx.store.strategy(s);};
 ctx.reopen=()=>{ctx.store.close();ctx.store=new Store(dir);engine();};
 t.after(()=>{ctx.store.close();rmSync(dir,{recursive:true,force:true});});return ctx;
}

test('team levels validate strictly, remain optional, and survive settings export/import',()=>{
 const s=strategy();assert.deepEqual(s.teamLevels,levels);assert.deepEqual(validateStrategy({name:'Old strategy'}).teamLevels,[]);
 for(const teamLevels of ['50',[{threshold:50,shares:0}],[{threshold:50.5,shares:1}],[{threshold:100,shares:1},{threshold:50,shares:1}],[{threshold:50,shares:1},{threshold:50,shares:2}],Array.from({length:21},(_,i)=>({threshold:i,shares:1}))])assert.throws(()=>strategy({teamLevels}));
 assert.throws(()=>validateStrategy({mode:'solo',teamLevels:levels}),/team packages/);
 const state={settings:DEFAULTS,strategies:[s],orders:[]};const imported=prepareConfigurationImport(configurationBackup(state),state,{idFactory:()=> 'new'});assert.deepEqual(imported.strategies[0].teamLevels,levels);assert.equal(imported.strategies[0].enabled,false);
});

test('50/100/150 buys exactly three additional shares with signed cumulative bodies and one ledger record',async t=>{
 const c=setup(t);c.provider.total=49;await c.engine.tick();assert.equal(c.provider.posts.length,0);
 for(const threshold of [50,100,150]){c.provider.total=threshold;c.due();await c.engine.tick();assert.equal(c.provider.posts.length,threshold/50);}
 assert.deepEqual(c.provider.posts.map(p=>p.body.amount),[.0001,.0002,.0003]);assert.deepEqual(c.provider.posts.map(p=>p.body.shares.small),[1,2,3]);assert.equal(new Set(c.provider.posts.map(p=>p.requestId)).size,3);
 await c.engine.sync();const state=c.store.state(),o=state.orders[0];assert.equal(state.orders.length,1);assert.equal(o.shares,3);assert.equal(o.costBtc,30000);assert.equal(o.feeBtc,0);assert.equal(o.pendingTeamPurchase,undefined);assert.deepEqual(o.teamBuys.map(b=>b.status),['CONFIRMED','CONFIRMED','CONFIRMED']);
 assert.equal(totals(state.orders,[],{mode:'live'}).spend,30000);assert.equal(totals(state.orders,[],{mode:'live'}).count,3);assert.equal(spendEntries(o).reduce((n,e)=>n+e.amountBtc,0),30000);assert.equal(o.rewardEstimate.memberShares,3);assert.equal(o.rewardEstimate.totalShares,151);
 assert.equal(state.runtime.balance,1970000);c.due();await c.engine.tick();assert.equal(c.provider.posts.length,3);
});

test('levels respect the interval and process reached thresholds one per evaluation',async t=>{
 const c=setup(t);c.provider.total=150;await c.engine.tick();assert.equal(c.provider.posts.length,1);
 await c.engine.tick();assert.equal(c.provider.posts.length,1);assert.equal(c.store.get('runtime').decisions[0].reason,'Waiting for next interval');
 c.due();await c.engine.tick();assert.equal(c.provider.posts.length,2);assert.deepEqual(c.store.orders()[0].teamBuys.map(b=>b.threshold),[50,100]);
 c.due();await c.engine.tick();assert.equal(c.provider.posts.length,3);
});

test('maximum purchases counts additions while concurrent packages count the single team',async t=>{
 const c=setup(t);c.store.strategy(strategy({maxPurchases:2}));await c.engine.tick();c.provider.total=100;c.due();await c.engine.tick();assert.equal(c.provider.posts.length,2);
 c.provider.total=150;c.due();await c.engine.tick();assert.equal(c.provider.posts.length,2);assert.equal(c.store.get('runtime').decisions[0].reason,'Purchase count reached');assert.equal(c.store.orders().length,1);
});

test('strategy budget and stop loss also apply to additional levels',async t=>{
 const c=setup(t);c.store.strategy(strategy({budget:20000,maxPrice:10000}));await c.engine.tick();c.provider.total=100;c.due();await c.engine.tick();assert.equal(c.provider.posts.length,2);
 c.provider.total=150;c.due();await c.engine.tick();assert.equal(c.store.get('runtime').decisions[0].reason,'Strategy budget reached');assert.equal(c.provider.posts.length,2);
 c.store.strategy(strategy());c.store.set('settings',{...c.store.get('settings'),stopLoss:20000});c.due();await c.engine.tick();assert.equal(c.store.get('runtime').decisions[0].reason,'Stop loss reached');assert.equal(c.provider.posts.length,2);
});

test('an older entry from this strategy is level one and only the new delta uses today’s cap',async t=>{
 const c=setup(t,{dailyCap:10000,maxOrder:10000});c.provider.shares=1;c.provider.total=100;
 const yesterday=new Date(Date.now()-86400000).toISOString();c.store.saveOrder({id:'earlier',externalId:id,packageId:id,strategyId:'levels',kind:'team',mode:'live',status:'PENDING',shares:1,costBtc:10000,feeBtc:0,createdAt:yesterday,source:'Strategy engine'});
 await c.engine.tick();assert.equal(c.provider.posts.length,1);assert.equal(c.provider.posts[0].body.amount,.0002);const o=c.store.orders()[0];assert.equal(o.id,'earlier');assert.equal(o.teamBuys[0].existingEntry,true);assert.equal(o.teamBuys[1].threshold,100);assert.equal(o.costBtc,20000);
 assert.equal(spendEntries(o).filter(e=>Date.parse(e.at)>Date.now()-3600000).reduce((n,e)=>n+e.amountBtc,0),10000);
 c.provider.total=150;c.due();await c.engine.tick();assert.equal(c.provider.posts.length,1);assert.equal(c.store.get('runtime').decisions[0].reason,'Daily spending cap');
});

test('manual or other-strategy team membership is never adopted for automatic additions',async t=>{
 const c=setup(t);c.provider.shares=1;c.provider.total=150;await c.engine.tick();assert.equal(c.provider.posts.length,0);assert.equal(c.store.orders()[0].strategyId,null);
 const o=c.store.orders()[0];o.strategyId='another-strategy';c.store.saveOrder(o);await c.engine.tick();assert.equal(c.provider.posts.length,0);
});

test('a rejected addition retains the owned team and prior spend while recording the failed level',async t=>{
 const c=setup(t);await c.engine.tick();c.provider.total=100;c.provider.outcome='404';c.due();await c.engine.tick();const o=c.store.orders()[0];
 assert.equal(o.externalId,id);assert.equal(o.costBtc,10000);assert.equal(o.shares,1);assert.equal(o.status,'PENDING');assert.equal(o.pendingTeamPurchase,undefined);assert.equal(o.teamBuys[1].status,'FAILED');assert.equal(o.teamBuys[1].failure.httpStatus,404);assert.equal(o.submissionFailure,undefined);
 assert.equal(totals(c.store.orders(),[],{mode:'live'}).count,1);assert.equal(totals(c.store.orders(),[],{mode:'live'}).spend,10000);assert.equal(c.store.get('settings').liveArmed,true);
 assert.equal(o.teamBuys[1].failure.teamCheck.finding,'still-listed-after-rejection');assert.equal(o.teamBuys[1].failure.teamCheck.shares,1);assert.equal(o.teamBuys[1].failure.teamCheck.additionalCostBtc,10000);
 await c.engine.sync();assert.equal(c.store.get('runtime').historyComplete,true);c.due();await c.engine.tick();assert.equal(c.provider.posts.length,2);
});
test('a rejected first level has no owned membership or funded purchase count',async t=>{
 const c=setup(t);c.provider.outcome='404';await c.engine.tick();const o=c.store.orders()[0];assert.equal(o.status,'FAILED');assert.equal(o.externalId,null);assert.equal(o.pendingTeamPurchase,undefined);assert.equal(o.teamBuys[0].status,'FAILED');assert.equal(totals(c.store.orders(),[],{mode:'live'}).spend,0);assert.equal(totals(c.store.orders(),[],{mode:'live'}).count,0);
});
test('a team closing after payout lookup skips an additional level and preserves the earlier ownership and cooldown',async t=>{
 const c=setup(t);await c.engine.tick();await c.engine.sync();c.provider.total=100;c.due();const old=c.store.orders()[0],lastBuyAt=c.store.strategies()[0].lastBuyAt;
 c.api.payoutDestination=async()=>{c.provider.state='SOLD_OUT';return {fields:{},requiresTwofa:false};};
 const result=await c.engine.tick(),order=c.store.orders()[0];assert.equal(c.provider.posts.length,1);assert.equal(order.costBtc,10000);assert.equal(order.shares,1);assert.equal(order.externalId,old.externalId);assert.equal(order.teamBuys.length,1);assert.equal(c.store.strategies()[0].lastBuyAt,lastBuyAt);assert.equal(c.store.get('runtime').historyComplete,true);assert.equal(c.store.get('settings').liveArmed,true);assert.match(result.decisions[0].reason,/Team or level price changed/);
});

test('a lost top-up response reserves the cumulative total and restart reconciliation never replays it',async t=>{
 const c=setup(t,{feeBufferBps:100});await c.engine.tick();c.provider.total=100;c.provider.outcome='timeout-after';c.due();await c.engine.tick();
 let o=c.store.orders()[0];assert.equal(o.status,'UNKNOWN');assert.equal(o.costBtc,20000);assert.equal(o.feeBtc,100);assert.equal(o.shares,2);assert.equal(totals(c.store.orders(),[],{mode:'live'}).spend,20100);assert.equal(c.store.get('settings').liveArmed,false);
 c.reopen();assert.equal(c.store.get('settings').running,false);await c.engine.sync();o=c.store.orders()[0];assert.equal(o.status,'PENDING');assert.equal(o.pendingTeamPurchase,undefined);assert.equal(o.costBtc,20000);assert.equal(o.feeBtc,0);assert.equal(o.teamBuys[1].status,'CONFIRMED');assert.equal(c.provider.posts.length,2);
 c.store.set('settings',{...c.store.get('settings'),running:true,liveArmed:true});c.provider.outcome='ok';c.due();await c.engine.tick();assert.equal(c.provider.posts.length,2);
 c.provider.total=150;c.due();await c.engine.tick();assert.equal(c.provider.posts.length,3);assert.equal(c.provider.posts[2].body.shares.small,3);
});

test('a missing or delayed top-up remains reserved and blocks new purchases until the full contribution is verified',async t=>{
 const c=setup(t);await c.engine.tick();c.provider.total=100;c.provider.outcome='delayed';c.due();await c.engine.tick();assert.equal(c.store.orders()[0].pendingTeamPurchase.targetCostBtc,20000);
 await c.engine.tick();let o=c.store.orders()[0];assert.equal(o.status,'UNKNOWN');assert.equal(o.costBtc,20000);assert.equal(c.store.get('runtime').historyComplete,false);assert.equal(c.provider.posts.length,2);
 c.provider.shares=2;await c.engine.sync();o=c.store.orders()[0];assert.equal(o.pendingTeamPurchase,undefined);assert.equal(o.teamBuys[1].status,'CONFIRMED');assert.equal(o.costBtc,20000);
});

test('fresh private preflight refuses changed participation, coupons and changed reward coins before POST',async t=>{
 const c=setup(t);c.provider.shares=1;c.provider.total=100;const pkg=(await c.api.packages())[0],q={...pkg,costBtc:10000,teamLevel:{threshold:100,shares:1},shares:1},s={...strategy(),shares:1};
 await assert.rejects(()=>c.api.prepareTeamLevel(q,s,{costBtc:20000,shares:2}),/participation changed/);c.provider.coupons=1;
 await assert.rejects(()=>c.api.prepareTeamLevel(q,s,{costBtc:10000,shares:1}),/coupons or mass buys/);assert.equal(c.provider.posts.length,0);
 c.provider.coupons=0;await assert.rejects(()=>c.api.prepareTeamLevel({...q,mergeCoin:'DOGE'},s,{costBtc:10000,shares:1}),/Team or level price changed/);assert.equal(c.provider.posts.length,0);
});

test('varying level quantities use additional-price ceilings and cumulative provider quantities',async t=>{
 const c=setup(t);c.store.strategy(strategy({maxPrice:30000,teamLevels:[{threshold:50,shares:2},{threshold:100,shares:3},{threshold:150,shares:1}]}));
 for(const threshold of [50,100,150]){c.provider.total=threshold;c.due();await c.engine.tick();}
 assert.deepEqual(c.provider.posts.map(p=>p.body.shares.small),[2,5,6]);assert.deepEqual(c.store.orders()[0].teamBuys.map(b=>b.amountBtc),[20000,30000,10000]);assert.equal(c.store.orders()[0].costBtc,60000);
});

test('personal payouts after several levels are counted once and never multiplied by level count',async t=>{
 const c=setup(t);for(const threshold of [50,100,150]){c.provider.total=threshold;c.due();await c.engine.tick();}
 c.provider.completed=true;c.provider.claimed=true;c.provider.rewards=[{coin:'BTC',rewardAmount:'0.00012345',rewardFeeAmount:0}];
 await c.engine.sync();await c.engine.sync();assert.equal(c.store.rewards().length,1);const result=totals(c.store.orders(),c.store.rewards(),{mode:'live'});assert.equal(result.earned,12345);assert.equal(result.spend,30000);assert.equal(result.net,-17655);
});

test('manual verification of an uncharged last addition restores only its delta and preserves earlier commitment',async t=>{
 const c=setup(t);await c.engine.tick();c.provider.total=100;c.provider.outcome='timeout-before';c.due();await c.engine.tick();
 const o=c.store.orders()[0];assert.equal(o.costBtc,20000);resolveUnboughtLevel(o,'Provider history verified: last addition not charged');c.store.saveOrder(o);
 assert.equal(o.externalId,id);assert.equal(o.costBtc,10000);assert.equal(o.shares,1);assert.equal(o.pendingTeamPurchase,undefined);assert.equal(o.teamBuys[1].status,'REJECTED');assert.equal(totals(c.store.orders(),[],{mode:'live'}).count,1);assert.equal(totals(c.store.orders(),[],{mode:'live'}).spend,10000);
});

test('paper demo uses the same level selection and accumulates one team allocation',async()=>{
 const pkg={id,name:'Team Gold',coin:'BTC',market:'BTC',team:true,available:true,costBtc:10000,minShare:10000,teamShares:50,teamCommitted:500000,blockRewards:[{coin:'BTC',amount:312500000}],duration:3600,quotedAt:new Date().toISOString()};
 const state={settings:{...DEFAULTS,running:true,paperBalance:10000000},strategies:[strategy()],orders:[],rewards:[],packages:[pkg],runtime:{},events:[]};
 const previous=globalThis.localStorage;globalThis.localStorage={setItem(){}};
 try{const demo=new DemoApi(state);for(const threshold of [50,100,150]){pkg.teamShares=threshold;pkg.teamCommitted=threshold*10000;state.strategies[0].lastBuyAt=null;await demo.request('/api/tick','POST');}
  assert.equal(state.orders.length,1);assert.equal(state.orders[0].shares,3);assert.equal(state.orders[0].costBtc,30000);assert.equal(state.orders[0].teamBuys.length,3);assert.equal(totals(state.orders,[],{mode:'paper'}).count,3);
  assert.equal(state.orders[0].rewardEstimate.totalShares,153);
 }finally{globalThis.localStorage=previous;}
});
