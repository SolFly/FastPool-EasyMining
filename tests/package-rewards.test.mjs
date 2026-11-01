import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {accountTeamEstimate,purchaseRewardEstimate,personalBlockRewards} from '../public/package-rewards.mjs';
import {normalizePackage,DEFAULTS,STRATEGY_DEFAULTS,totals} from '../public/core.mjs';
import {fiatValue,rewardSummary} from '../public/rewards.mjs';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {ManualPurchases} from '../server/manual-purchases.mjs';

const at='2026-10-25T15:51:00.000Z';
const member=()=>({organizationId:'mine',addedAmount:'0.0010',claimed:true,paymentStatus:'OK',rewards:[]});
const team=()=>({id:'example-35a07952',addedAmount:'0.0041',fullAmount:'0.1',minShareAmount:'0.0001',status:'COMPLETED',createdTs:at,
  currencyAlgoTicket:{name:'Team Silver',currencyMarket:'BTC',minShareAmount:'0.0001',currencyAlgo:{currency:'BCH',blockReward:3.09375,blockRewardWithNhFee:3.125}},
  members:[member(),{organizationId:'another-member',addedAmount:'0.0031'}],orderDetails:{soloReward:[{coin:'BCH',depositComplete:true,payoutReward:312500000}]}});
function setup(t){const dir=mkdtempSync(join(tmpdir(),'fp-team-reward-')),store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});store.saveCredentials({key:'test',secret:'test',orgId:'mine'});return {store,engine:new Engine(store)};}

test('the reported 10/41 example is 0.76219512 BCH per block and about EUR 195.03',()=>{
  const raw=team(),e=accountTeamEstimate(raw,raw.members[0],at);
  assert.equal(e.memberShares,10);assert.equal(e.totalShares,41);assert.equal(e.fraction,10/41);assert.equal(e.memberAmount,100000);assert.equal(e.totalAmount,410000);
  assert.equal(e.blocks[0].fullAmount,312500000);assert.equal(e.blocks[0].amount,76219512);
  assert.equal(fiatValue(e.blocks[0].amount,'BCH','EUR',{fiat:{EUR:{BCH:799.64/3.125}}}).toFixed(2),'195.03');
});

test('private team totals include the member already and package capacity is not the denominator',()=>{
  const raw=team();raw.fullAmount='0.1';raw.numberOfParticipants=2;raw.members[0].shares={small:1};
  const e=accountTeamEstimate(raw,raw.members[0]);assert.equal(e.totalShares,41);assert.equal(e.memberShares,10);assert.equal(e.blocks[0].amount,76219512);
  delete raw.minShareAmount;delete raw.currencyAlgoTicket.minShareAmount;
  assert.equal(accountTeamEstimate(raw,raw.members[0]).memberShares,10);
});

test('share calculations use BigInt and round the personal estimate down once',()=>{
  const raw=team();raw.addedAmount='0.0003';raw.members[0].addedAmount='0.0001';raw.currencyAlgoTicket.currencyAlgo.blockRewardWithNhFee='2E-8';
  assert.equal(accountTeamEstimate(raw,raw.members[0]).blocks[0].amount,0);
  raw.currencyAlgoTicket.currencyAlgo.blockRewardWithNhFee='0.00000003';assert.equal(accountTeamEstimate(raw,raw.members[0]).blocks[0].amount,1);
});

test('missing or contradictory team contribution data never becomes a full-block personal reward',()=>{
  for(const total of [undefined,null,'malformed','0','0.0001']){
    const raw=team();raw.addedAmount=total;const e=accountTeamEstimate(raw,raw.members[0]);
    assert.equal(e.fraction,null);assert.equal(e.blocks[0].amount,null);assert.match(e.note,/unavailable/);
  }
  assert.deepEqual(personalBlockRewards({kind:'team',reward:3.125,shares:10}),[]);
  const unknown=purchaseRewardEstimate({team:true,coin:'BCH',reward:3.125,costBtc:10000},10);assert.equal(unknown.fraction,null);assert.equal(unknown.blocks[0].amount,null);
});

test('new purchase snapshot adds requested shares once and preserves merged coin estimates',()=>{
  const raw={...team(),addedAmount:'0.0031',status:'WAITING',state:'OPEN'};
  raw.currencyAlgoTicket.mergeCurrencyAlgo={currency:'DOGE',blockRewardWithNhFee:'10000'};
  const p=normalizePackage(raw,at,true),e=purchaseRewardEstimate(p,10,at);
  assert.equal(e.totalShares,41);assert.equal(e.memberShares,10);assert.equal(e.fraction,10/41);assert.equal(e.blocks[0].amount,76219512);assert.equal(e.blocks[1].amount,243902439024);
  p.teamShares=1000;p.teamCommitted=10000000;assert.equal(e.totalShares,41);assert.equal(e.blocks[0].amount,76219512);
});

test('unknown catalogue team total stays unknown; a verified empty lobby can start at full ownership',()=>{
  const raw=team();delete raw.addedAmount;
  const p=normalizePackage(raw,at,true);assert.equal(p.teamShares,null);assert.equal(p.teamCommitted,null);assert.equal(purchaseRewardEstimate(p,10).fraction,null);
  raw.addedAmount='0';assert.equal(purchaseRewardEstimate(normalizePackage(raw,at,true),10).fraction,1);
});

test('live team earnings use only the already allocated net member payout, never a second fraction',t=>{
  const {store,engine}=setup(t),raw=team();
  raw.members[0].rewards=[{coin:'BCH',rewardAmount:'0.76219512195121951219512',rewardFeeAmount:'0.00762195121951219512195'}];
  raw.members[1].rewards=[{coin:'BCH',rewardAmount:3.125}];
  const order=engine.importTeam(raw,{BTC:1,BCH:.0035});engine.importTeam(raw,{BTC:1,BCH:.0035});
  assert.equal(order.kind,'team');assert.equal(order.shares,10);assert.equal(order.costBtc,100000);assert.equal(order.rewardEstimate.blocks[0].amount,76219512);
  assert.equal(store.rewards().length,1);const reward=store.rewards()[0];assert.equal(reward.amount,76219512);assert.equal(reward.scope,'team-member');assert.equal(reward.confirmed,true);assert.equal(reward.valueBtc,266768);
  const report=totals(store.orders(),store.rewards(),{mode:'live'});assert.equal(report.earned,266768);assert.equal(report.spend,100000);assert.equal(report.net,166768);
  const coins=rewardSummary(store.orders(),store.rewards(),{mode:'live'});assert.equal(coins.find(r=>r.coin==='BCH').confirmed,76219512);
});

test('a potential block estimate never creates an earned or pending accounting reward',t=>{
  const {store,engine}=setup(t),raw=team();raw.members[0].claimed=false;
  const o=engine.importTeam(raw);assert.equal(o.rewardEstimate.blocks[0].amount,76219512);assert.equal(store.rewards().length,0);
  const report=totals(store.orders(),store.rewards(),{mode:'live'});assert.equal(report.earned,0);assert.equal(report.pending,0);
});

test('actual pending member payouts become confirmed without double scaling or duplicate credit',t=>{
  const {store,engine}=setup(t),raw=team();raw.members[0].claimed=false;raw.members[0].rewards=[{coin:'BCH',rewardAmount:'0.76219512195121951219',rewardFeeAmount:0}];
  engine.importTeam(raw,{BCH:.0035});assert.equal(store.rewards()[0].amount,76219512);assert.equal(store.rewards()[0].confirmed,false);
  raw.members[0].claimed=true;engine.importTeam(raw,{BCH:.0035});engine.importTeam(raw,{BCH:.0035});
  assert.equal(store.rewards().length,1);assert.equal(store.rewards()[0].amount,76219512);assert.equal(store.rewards()[0].confirmed,true);
});

test('a later private team total refreshes the estimate without adding the member again or changing recorded payout',t=>{
  const {store,engine}=setup(t),raw=team();raw.members[0].rewards=[{coin:'BCH',rewardAmount:0.76219512,rewardFeeAmount:0}];
  engine.importTeam(raw);raw.addedAmount='0.005';const order=engine.importTeam(raw);
  assert.equal(order.rewardEstimate.totalShares,50);assert.equal(order.rewardEstimate.blocks[0].amount,62500000);assert.equal(store.rewards()[0].amount,76219512);
});

test('an existing order with an old default of one share refreshes to the actual ten shares',t=>{
  const {store,engine}=setup(t);store.saveOrder({id:'old',externalId:team().id,kind:'team',mode:'live',status:'COMPLETED',shares:1,costBtc:100000,createdAt:at});
  const o=engine.importTeam(team());assert.equal(o.id,'old');assert.equal(o.shares,10);assert.equal(o.rewardEstimate.totalShares,41);
});

test('paper manual purchase settles its stored personal allocation after the team leaves the catalogue',async t=>{
  const {store,engine}=setup(t),manual=new ManualPurchases(engine);store.set('settings',{...DEFAULTS,maxOrder:110000,dailyCap:200000,weeklyCap:500000,monthlyCap:1000000});
  const p=normalizePackage({...team(),id:'package',status:'WAITING',state:'OPEN',addedAmount:'0.0031',probabilityPrecision:1},at,true);
  engine.refreshPackages=async()=>store.set('packages',[{...p,quotedAt:new Date().toISOString()}]);
  const quote=await manual.quote({packageId:p.id,shares:10});assert.equal(quote.rewardEstimate.blocks[0].amount,76219512);
  const {order}=await manual.buy(quote.id);assert.equal(order.rewardEstimate.totalShares,41);
  order.endAt=at;store.saveOrder(order);store.set('packages',[]);store.set('runtime',{rates:{BCH:.0035}});engine.settlePaper();engine.settlePaper();
  assert.equal(store.rewards().length,1);assert.equal(store.rewards()[0].amount,76219512);assert.equal(store.rewards()[0].scope,'team-member');
});

test('strategy purchases save the same allocation snapshot without using multiplied price twice',async t=>{
  const {store,engine}=setup(t);store.set('settings',{...DEFAULTS,running:true,maxOrder:110000,dailyCap:200000});
  store.strategy({...STRATEGY_DEFAULTS,id:'s',enabled:true,kind:'interval',mode:'team',coin:'BCH',packageName:'Team Silver',shares:10,maxPrice:100000,budget:200000,minTeamShares:0,stopOnWin:false});
  const p=normalizePackage({...team(),status:'WAITING',state:'OPEN',addedAmount:'0.0031',probabilityPrecision:1},at,true);
  engine.refreshPackages=async()=>store.set('packages',[{...p,quotedAt:new Date().toISOString()}]);
  await engine.tick();assert.equal(store.orders().length,1);assert.equal(store.orders()[0].rewardEstimate.totalAmount,410000);assert.equal(store.orders()[0].rewardEstimate.blocks[0].amount,76219512);
});

test('legacy paper team win without an allocation does not invent a full-block payout; solo remains whole',t=>{
  const {store,engine}=setup(t);
  for(const kind of ['team','solo'])store.saveOrder({id:kind,kind,name:kind,mode:'paper',status:'ACTIVE',createdAt:at,endAt:at,odds:1,reward:3.125,coin:'BCH',shares:10,costBtc:100000});
  engine.settlePaper();assert.equal(store.rewards().length,1);assert.equal(store.rewards()[0].orderId,'solo');assert.equal(store.rewards()[0].amount,312500000);assert.match(store.orders().find(o=>o.id==='team').rewardEstimateNote,/unavailable/);
});
