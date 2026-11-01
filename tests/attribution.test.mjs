import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {DEFAULTS,STRATEGY_DEFAULTS,totals,isCurrent,guard} from '../public/core.mjs';
import {rewardSummary} from '../public/rewards.mjs';
import {soloReward} from '../server/nicehash.mjs';

const org='mine',executionId='4a0f6fc4-d8df-4d7f-b2cc-7a4bb747f5cc',teamId='88888888-8888-4888-8888-888888888888';
const at='2026-10-25T15:51:00.000Z';
const wholeReward=()=>({id:'whole-block-reward',coin:'BCH',payoutReward:303133399,payoutRewardBtc:.01046637,shared:true,packageId:teamId,depositComplete:true,createdTs:at});
const embedded=()=>({id:teamId,status:'CREATED',addedAmount:'0.0041',minShareAmount:'0.0001',currencyAlgoTicket:{name:'Team Silver',currencyMarket:'BTC',currencyAlgo:{currency:'BCH',blockRewardWithNhFee:3.125}},
  members:[{organizationId:org,addedAmount:'.001',claimed:true,paymentStatus:'OK',rewards:[{coin:'BCH',rewardAmount:'.73934975365853658536',rewardFeeAmount:'.00746818'}]}]});
const history=()=>({id:executionId,amount:.004033,status:'COMPLETED',createdTs:at,soloMiningCoin:'BCH',soloReward:[wholeReward()],sharedTicket:embedded()});
function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'fp-attribution-')),store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 store.saveCredentials({orgId:org,key:'mock',secret:'mock'});store.set('settings',{...DEFAULTS,mode:'live',running:true,liveArmed:true});
 const engine=new Engine(store);let account=[],details=new Map(),rewardRows=[];const calls=[];
 const api={credentials:{orgId:org},syncClock:async()=>{},balances:async()=>({currencies:[{currency:'BTC',available:1,btcRate:1},{currency:'BCH',btcRate:.00345272}]}),
   pages:async path=>path.endsWith('/shared/order')?[]:account,
   ticket:async(id,team=false)=>{calls.push({id,team});if(!details.has(id))throw new Error('No verified detail');return structuredClone(details.get(id));},
   request:async()=>rewardRows};
 engine.client=()=>api;
 return {store,engine,api,calls,setAccount:a=>account=a,setDetail:(id,d)=>details.set(id,d),setRewardRows:r=>rewardRows=r};
}
function oldWrongEntry(store){
 store.saveOrder({id:'legacy-whole-team',externalId:executionId,kind:'solo',mode:'live',source:'NiceHash import',coin:'BCH',name:'BCH imported',status:'COMPLETED',costBtc:403300,feeBtc:0,refundBtc:0,shares:1,createdAt:at});
 store.reward({id:'legacy-reward',orderId:'legacy-whole-team',coin:'BCH',amount:303133399,valueBtc:1046637,confirmed:true,createdAt:at});
}

test('the reported execution embedded as sharedTicket is imported as a personal team entry without a catalogue',async t=>{
 const {store,engine,calls,setAccount}=setup(t);setAccount([history()]);const result=await engine.sync();
 assert.equal(result.historyComplete,true);assert.equal(result.solo,0);assert.equal(result.teams,1);assert.deepEqual(calls,[]);
 const o=store.orders()[0];assert.equal(store.orders().length,1);assert.equal(o.kind,'team');assert.equal(o.status,'COMPLETED');assert.equal(o.costBtc,100000);assert.equal(o.shares,10);assert.equal(o.rewardEstimate.totalShares,41);assert.equal(o.attribution.state,'team-member');
 assert.deepEqual(o.providerOrderIds,[executionId]);assert.equal(store.rewards().length,1);assert.equal(store.rewards()[0].amount,73934975);
 assert.equal(rewardSummary(store.orders(),store.rewards(),{mode:'live'}).find(r=>r.coin==='BCH').confirmed,73934975);
});

test('existing inflated solo costs and full-team rewards are superseded atomically and stay in the audit export',async t=>{
 const {store,engine,setAccount}=setup(t);oldWrongEntry(store);engine.prepareAttributionAudit();
 assert.equal(totals(store.orders(),store.rewards(),{mode:'live'}).earned,0);assert.equal(totals(store.orders(),store.rewards(),{mode:'live'}).reviewCount,1);
 setAccount([history()]);await engine.sync();await engine.sync();
 assert.equal(store.orders().filter(isCurrent).length,1);assert.equal(store.orders().find(o=>o.id==='legacy-whole-team').status,'SUPERSEDED');assert.equal(store.rewards().find(r=>r.id==='legacy-reward').amount,303133399);
 const report=totals(store.orders(),store.rewards(),{mode:'live'});assert.equal(report.spend,100000);assert.equal(report.reviewCount,0);assert.equal(report.earned,Math.round(73934975*.00345272));
 assert.equal(store.rewards().filter(r=>r.teamId===teamId).length,1);
});

test('a failed team repair leaves the old payout excluded while retaining its full spending reservation',async t=>{
 const {store,engine,setAccount}=setup(t);oldWrongEntry(store);const raw=history();raw.sharedTicket.members[0].rewards[0].rewardAmount='invalid';setAccount([raw]);
 const result=await engine.sync();assert.equal(result.historyComplete,false);assert.equal(store.orders().length,1);assert.equal(store.orders()[0].costBtc,403300);assert.equal(store.rewards()[0].amount,303133399);
 const report=totals(store.orders(),store.rewards(),{mode:'live'});assert.equal(report.earned,0);assert.equal(report.spend,0);assert.equal(report.reviewCost,403300);
 assert.equal(rewardSummary(store.orders(),store.rewards(),{mode:'live'}).find(r=>r.coin==='BCH').confirmed,0);
 assert.match(guard({...store.state(),settings:{...store.get('settings'),running:true,liveArmed:true}},{...STRATEGY_DEFAULTS,enabled:true},null),/ownership/);
 assert.equal(store.get('settings').running,true);assert.equal(store.get('settings').liveArmed,true);
});

test('a shared reward marker without a team ID is held rather than credited as a full block',async t=>{
 const {store,engine,setAccount}=setup(t),raw=history();delete raw.sharedTicket;delete raw.soloReward[0].packageId;setAccount([raw]);
 const result=await engine.sync();assert.equal(result.historyComplete,false);assert.equal(store.orders().length,1);assert.equal(store.orders()[0].attribution.state,'review');assert.equal(store.rewards().length,0);assert.equal(totals(store.orders(),[],{mode:'live'}).reviewCount,1);
});

test('a reward-level team reference requires the exact execution link before repair',async t=>{
 const {store,engine,setAccount,setDetail}=setup(t),raw=history();delete raw.sharedTicket;
 setAccount([raw]);setDetail(teamId,{...embedded(),orderDetails:{id:executionId,status:'COMPLETED',soloReward:[wholeReward()]}});
 await engine.sync();assert.equal(store.orders().filter(isCurrent)[0].kind,'team');assert.equal(store.rewards()[0].amount,73934975);
});

test('a reward reference pointing at a different execution never credits its members',async t=>{
 const {store,engine,setAccount,setDetail}=setup(t),raw=history();delete raw.sharedTicket;setAccount([raw]);setDetail(teamId,{...embedded(),orderDetails:{id:'different-order'}});
 const result=await engine.sync();assert.equal(result.historyComplete,false);assert.equal(store.rewards().length,0);assert.equal(store.orders()[0].attribution.state,'review');
});

test('shared markers fetched from the reward endpoint are routed through member accounting',async t=>{
 const {store,engine,setAccount,setRewardRows,setDetail}=setup(t);const raw=history();delete raw.sharedTicket;delete raw.soloReward;setAccount([raw]);setRewardRows([wholeReward()]);
 setDetail(teamId,{...embedded(),orderDetails:{id:executionId,status:'COMPLETED',soloReward:[wholeReward()]}});await engine.sync();assert.equal(store.orders().filter(isCurrent)[0].kind,'team');assert.equal(store.rewards()[0].amount,73934975);
});

test('completed legacy imports missing from the list are audited through exact order details',async t=>{
 const {store,engine,setDetail}=setup(t);oldWrongEntry(store);setDetail(executionId,history());const result=await engine.sync();assert.equal(result.historyComplete,true);assert.equal(store.orders().filter(isCurrent)[0].kind,'team');assert.equal(store.rewards().find(r=>r.teamId).amount,73934975);
});

test('a legitimate large solo win remains fully counted when personal ownership is verified',async t=>{
 const {store,engine,setAccount}=setup(t);setAccount([{id:'personal-solo',organizationId:org,amount:.001,status:'COMPLETED',createdTs:at,soloMiningCoin:'BTC',soloReward:[{id:'solo-win',coin:'BTC',payoutReward:307303083,payoutRewardBtc:3.07303083,depositComplete:true,shared:false,createdTs:at}]}]);
 const result=await engine.sync();assert.equal(result.historyComplete,true);assert.equal(store.orders()[0].kind,'solo');assert.equal(store.orders()[0].attribution.state,'personal');assert.equal(totals(store.orders(),store.rewards(),{mode:'live'}).earned,307303083);
});

test('missing personal proof triggers a detail check and remains excluded until positively verified',async t=>{
 const {store,engine,setAccount,setDetail}=setup(t);const raw={id:'unclear',amount:.001,status:'COMPLETED',soloMiningCoin:'BTC',createdTs:at,soloReward:[{id:'unverified-win',coin:'BTC',payoutReward:300000000,depositComplete:true,createdTs:at}]};setAccount([raw]);setDetail(raw.id,raw);
 await engine.sync();assert.equal(store.orders()[0].attribution.state,'review');assert.equal(store.rewards().length,0);
 setDetail(raw.id,{...raw,organizationId:org});await engine.sync();assert.equal(store.orders()[0].attribution.state,'personal');assert.equal(store.rewards()[0].amount,300000000);
});

test('manually valued or reconciled duplicates retain their values and are flagged instead of silently rewritten',async t=>{
 const {store,engine,setAccount}=setup(t);oldWrongEntry(store);store.reward({...store.rewards()[0],valuation:'Manual valuation: checked transaction'});setAccount([history()]);
 const result=await engine.sync();assert.equal(result.historyComplete,false);assert.equal(store.orders().length,1);assert.equal(store.orders()[0].costBtc,403300);assert.equal(store.rewards()[0].amount,303133399);assert.equal(totals(store.orders(),store.rewards(),{mode:'live'}).earned,0);
});

test('already net member rewards retain reported fees separately and old fee deductions recover once',t=>{
 const {store,engine}=setup(t);const raw={...embedded(),orderDetails:{id:executionId,status:'COMPLETED',soloReward:[wholeReward()]}};
 const o=engine.importTeam(raw);const reward=store.rewards()[0];reward.amount-=100;store.reward(reward);
 engine.importTeam(raw);engine.importTeam(raw);assert.equal(store.rewards().reduce((n,r)=>n+r.amount,0),73934975);assert.equal(store.orders()[0].reportedRewardFees.BCH,746818);assert.equal(o.costBtc,100000);
});

test('solo reward normalizer rejects a shared full-team reward even if called directly',()=>{
 assert.throws(()=>soloReward(wholeReward(),'order'),/shared team reward/);
});
test('embedded repairs correct coin totals across BTC BCH LTC DOGE and ZEC without magnitude heuristics',async t=>{
 const {store,engine,setAccount}=setup(t);
 const cases=[['BTC',307303083,307303],['BCH',1837815003,73934975],['LTC',1226985900,12269859],['DOGE',2933072657745,29330726577],['ZEC',243428594,2434285]];
 const rows=cases.map(([coin,whole,personal],index)=>{
   const raw=history();raw.id='execution-'+coin;raw.soloMiningCoin=coin;raw.sharedTicket.id='team-'+coin;raw.sharedTicket.currencyAlgoTicket.currencyAlgo.currency=coin;
   raw.soloReward=[{...wholeReward(),id:'whole-'+coin,coin,payoutReward:whole,packageId:raw.sharedTicket.id}];raw.sharedTicket.members[0].rewards=[{coin,rewardAmount:(personal/100000000).toFixed(8),rewardFeeAmount:0}];
   store.saveOrder({id:'old-'+coin,externalId:raw.id,mode:'live',kind:'solo',source:'NiceHash import',coin,status:'COMPLETED',costBtc:403300,createdAt:at});
   store.reward({id:'old-reward-'+coin,orderId:'old-'+coin,coin,amount:whole,valueBtc:whole,confirmed:true,createdAt:at});return raw;
 });
 setAccount(rows);await engine.sync();await engine.sync();const summary=rewardSummary(store.orders(),store.rewards(),{mode:'live'});
 for(const [coin,,personal] of cases)assert.equal(summary.find(r=>r.coin===coin).confirmed,personal);
 assert.equal(store.orders().filter(isCurrent).length,5);assert.equal(totals(store.orders(),store.rewards(),{mode:'live'}).spend,500000);
});
test('contradictory owner evidence cannot reuse cached personal ownership',async t=>{
 const {store,engine,setAccount,setDetail}=setup(t);const raw={id:'owner-check',organizationId:org,amount:.001,status:'COMPLETED',createdTs:at,soloMiningCoin:'BTC',soloReward:[]};setAccount([raw]);await engine.sync();
 assert.equal(store.orders()[0].attribution.state,'personal');const changed={...raw,organizationId:'different'};setAccount([changed]);setDetail(raw.id,changed);await engine.sync();assert.equal(store.orders()[0].attribution.state,'review');
});
test('a decreased provider payout is excluded rather than retaining an overstated confirmed total',t=>{
 const {store,engine}=setup(t);const raw={...embedded(),orderDetails:{id:executionId,status:'COMPLETED',soloReward:[wholeReward()]}};engine.importTeam(raw);
 raw.members[0].rewards[0].rewardAmount='.1';engine.importTeam(raw);assert.equal(store.orders()[0].attribution.state,'review');assert.equal(store.rewards()[0].amount,73934975);assert.equal(totals(store.orders(),store.rewards(),{mode:'live'}).earned,0);
});
test('member reward rows for the same coin are summed exactly before rounding, including currency aliases',t=>{
 const {store,engine}=setup(t);const raw={...embedded(),orderDetails:{id:executionId,status:'COMPLETED',soloReward:[wholeReward()]}};
 raw.members[0].rewards=[{currency:'BCH',rewardAmount:'1.1E-8',rewardFeeAmount:'1E-9'},{coin:'BCH',rewardAmount:'9E-9',rewardFeeAmount:'9E-9'}];
 engine.importTeam(raw);engine.importTeam(raw);assert.equal(store.rewards().length,1);assert.equal(store.rewards()[0].amount,2);assert.equal(store.orders()[0].reportedRewardFees.BCH,1);
});
