import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULTS,STRATEGY_DEFAULTS,units,decimal,totals,guard,normalizePackage,validateSettings,validateStrategy,localParts,inWindow,pickQuote} from '../public/core.mjs';
const NOW=Date.parse('2026-10-26T12:00:00Z');
const iso=new Date(NOW).toISOString();
const strategy=()=>({...STRATEGY_DEFAULTS,continuous:false,id:'s',enabled:true,stopOnWin:false,budget:100000,maxPrice:10000,maxPurchases:10});
const quote=()=>({id:'p',market:'BTC',costBtc:10000,available:true,quotedAt:iso,odds:200,teamShares:60});
const state=()=>({settings:{...DEFAULTS,running:true,timezone:'UTC',feeBufferBps:0},strategies:[],orders:[],rewards:[],runtime:{errors:0,lastSync:iso,balance:2000000}});
const order=(extra={})=>({id:'o',mode:'paper',strategyId:'s',costBtc:10000,feeBtc:0,refundBtc:0,status:'COMPLETED',createdAt:iso,...extra});
test('decimal values retain exact satoshi precision and reject unsafe input',()=>{
  assert.equal(units('0.00000001'),1);assert.equal(units('0.00123456'),123456);assert.equal(units(1e-8),1);
  assert.equal(decimal(-123456),'-0.00123456');assert.equal(units('0.1')+units('0.2'),30000000);
  assert.throws(()=>units('0.000000001'));assert.throws(()=>units(Infinity));assert.throws(()=>units('NaN'));
});
test('pending rewards are excluded and refunds/fee reservations affect spend',()=>{
  const os=[order({feeBtc:200,refundBtc:100}),order({id:'failed',status:'FAILED',costBtc:90000}),order({id:'active',status:'ACTIVE',costBtc:3000}),order({id:'live',mode:'live',costBtc:9999})];
  const rs=[{id:'r',orderId:'o',amount:6000,confirmed:true,valueBtc:6000,createdAt:iso},{id:'p',orderId:'active',amount:50000,confirmed:false,valueBtc:50000,createdAt:iso}];
  const t=totals(os,rs);assert.equal(t.spend,13100);assert.equal(t.earned,6000);assert.equal(t.pending,50000);assert.equal(t.net,-7100);assert.equal(t.settledNet,-4100);assert.equal(t.active,1);assert.equal(t.winRate,100);
});
test('a reward with no BTC value is explicit rather than silently valued at zero',()=>{
  const t=totals([order()],[{orderId:'o',amount:1,confirmed:true,valueBtc:null,createdAt:iso}]);assert.equal(t.unpriced,1);assert.equal(t.earned,0);
});
test('a cancelled package with a partial refund retains the final net loss',()=>{
  const t=totals([order({status:'CANCELLED',costBtc:10000,refundBtc:7000})],[]);assert.equal(t.spend,3000);assert.equal(t.net,-3000);
});
test('rule is eligible only when every guard passes',()=>{assert.equal(guard(state(),strategy(),quote(),NOW),null);});
test('daily cap includes unknown purchase reservations',()=>{
  const st=state();st.orders.push(order({status:'UNKNOWN',costBtc:99000}));assert.match(guard(st,strategy(),quote(),NOW),/Unresolved/);
  st.orders[0].status='COMPLETED';st.orders[0].strategyId='other';assert.equal(guard(st,strategy(),quote(),NOW),'Daily spending cap');
});
test('budget and wallet guards include price/fee buffer',()=>{
  const st=state(),s=strategy();st.settings.feeBufferBps=100;s.budget=10000;assert.equal(guard(st,s,quote(),NOW),'Strategy budget reached');
  s.budget=100000;st.settings.paperBalance=110000;assert.equal(guard(st,s,quote(),NOW),'Minimum wallet reserve');
});
test('weekly/monthly limits account for purchases made by other strategies',()=>{
  const st=state();st.settings.dailyCap=50000;st.settings.weeklyCap=50000;st.settings.monthlyCap=100000;
  st.orders.push(order({strategyId:'other',costBtc:45000,createdAt:'2026-10-26T10:00:00Z'}));assert.equal(guard(st,strategy(),quote(),NOW),'Daily spending cap');
  st.settings.timezone='UTC';st.settings.dailyCap=50000;st.orders[0].createdAt='2026-10-25T10:00:00Z';st.orders[0].costBtc=95000;
  assert.equal(guard(st,strategy(),quote(),NOW),'Monthly spending cap');
});
test('live mode requires explicit arming and fresh account data',()=>{
  const st=state();st.settings.mode='live';assert.match(guard(st,strategy(),quote(),NOW),/not armed/);
  st.settings.liveArmed=true;st.runtime.lastSync='2026-10-25T00:00:00Z';assert.match(guard(st,strategy(),quote(),NOW),/stale/);
});
test('partial history cannot fund a new live purchase even with fresh balances and arming',()=>{
  const st=state();st.settings.mode='live';st.settings.liveArmed=true;st.runtime.historyComplete=false;
  assert.match(guard(st,strategy(),quote(),NOW),/history is incomplete/);
});
test('stale quotes, low team participation, and repeat teams do not purchase',()=>{
  const st=state(),s=strategy(),q=quote();q.quotedAt='2026-10-25T00:00:00Z';assert.match(guard(st,s,q,NOW),/quote is stale/);
  q.quotedAt=iso;s.mode='team';q.teamShares=10;assert.match(guard(st,s,q,NOW),/team share/);
  q.teamShares=60;st.orders.push(order({packageId:'p'}));assert.match(guard(st,s,q,NOW),/Already joined/);
});
test('stop loss, take profit, concurrency, cooldown and stop after reward',()=>{
  const st=state(),s=strategy();st.settings.stopLoss=5000;st.orders.push(order());assert.equal(guard(st,s,quote(),NOW),'Stop loss reached');
  st.settings.stopLoss=0;st.rewards.push({orderId:'o',amount:100000,confirmed:true,valueBtc:100000,createdAt:iso});st.settings.takeProfit=50000;
  assert.equal(guard(st,s,quote(),NOW),'Take profit reached');st.settings.takeProfit=0;s.stopOnWin=true;assert.match(guard(st,s,quote(),NOW),/confirmed reward/);
  s.stopOnWin=false;s.lastBuyAt=iso;assert.match(guard(st,s,quote(),NOW),/next interval/);s.lastBuyAt=null;
  st.settings.maxActive=1;st.orders[0].status='ACTIVE';assert.match(guard(st,s,quote(),NOW),/Concurrent/);
});
test('odds threshold never treats missing probability as eligible',()=>{
  const s={...strategy(),kind:'odds',maxOdds:100};assert.match(guard(state(),s,quote(),NOW),/Probability/);
  assert.match(guard(state(),s,{...quote(),odds:null},NOW),/Probability/);
});
test('calendar windows support midnight crossing and Sofia DST',()=>{
  assert.equal(inWindow('23:00','22:00','03:00'),true);assert.equal(inWindow('02:00','22:00','03:00'),true);assert.equal(inWindow('12:00','22:00','03:00'),false);
  assert.equal(localParts('2026-10-26T22:30:00Z','Europe/Sofia').date,'2026-10-27');
  assert.equal(localParts('2026-07-26T22:30:00Z','Europe/Sofia').time,'01:30');
});
test('team catalogue computes shares from funded amount, not participant count',()=>{
  const p=normalizePackage({id:'t',addedAmount:0.0068,minShareAmount:0.0001,numberOfParticipants:4,status:'WAITING',state:'OPEN',currencyAlgoTicket:{name:'Team Gold',minShareAmount:0.0001,price:0.03,currencyMarket:'BTC',currencyAlgo:{currency:'BTC'},duration:14400}},iso,true);
  assert.equal(p.teamShares,68);assert.equal(p.costBtc,10000);assert.equal(p.available,true);
  const q=pickQuote([p],{...strategy(),mode:'team',coin:'BTC',packageName:'Team Gold',shares:3});assert.equal(q.costBtc,30000);
});
test('validation rejects inconsistent caps, invalid schedules and unsupported strategies',()=>{
  assert.throws(()=>validateSettings({dailyCap:90000000}));assert.throws(()=>validateSettings({timezone:'Invalid/Zone'}));assert.throws(()=>validateSettings({pollSeconds:1}));
  assert.throws(()=>validateStrategy({days:[]}));assert.throws(()=>validateStrategy({kind:'martingale'}));assert.throws(()=>validateStrategy({startHour:'99:00'}));
  assert.equal(validateStrategy({kind:'team'}).mode,'team');
});
test('successive team selection skips already funded teams',()=>{
  const s={...strategy(),mode:'team',coin:'BTC',packageName:'Team Gold',shares:1};
  const p={id:'one',name:'Team Gold',coin:'BTC',team:true,market:'BTC',available:true,costBtc:10000};
  assert.equal(pickQuote([p,{...p,id:'two'}],s,[order({packageId:'one'})]).id,'two');
});
test('reward date filters use first observed confirmation when available',()=>{
  const r={orderId:'o',amount:20000,confirmed:true,valueBtc:20000,createdAt:'2026-10-20T00:00:00Z',confirmedAt:iso};
  assert.equal(totals([order({createdAt:'2026-10-20T00:00:00Z'})],[r],{from:NOW-3600000}).earned,20000);
});
