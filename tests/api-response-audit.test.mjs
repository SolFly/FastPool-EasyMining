import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizePackage,totals,guard,DEFAULTS,STRATEGY_DEFAULTS,isRewardAccounted} from '../public/core.mjs';
import {normalizeRates,rewardSummary} from '../public/rewards.mjs';
import {dailyProfits} from '../public/daily-profits.mjs';
const fixture=JSON.parse(readFileSync(new URL('../internal/controller/testdata/nicehash-public-2026-10-28.json',import.meta.url)));
test('captured NiceHash catalogue preserves live duration, team ID, shares, reward coins and payment market',()=>{
 for(const raw of fixture.teams){
  const q=normalizePackage(raw,fixture.capturedAt,true);
  assert.equal(q.id,raw.id);assert.notEqual(q.id,raw.currencyAlgoTicket.id);assert.equal(q.duration,raw.duration);
  assert.equal(q.teamShares,Math.floor(raw.addedAmount/raw.minShareAmount+1e-9));
  if(q.market==='BTC')assert.equal(q.costBtc,10000);
  else {assert.equal(q.market,'USDT');assert.equal(q.costBtc,undefined);assert.equal(q.costAmount,100000000);}
  assert.equal(q.coin,raw.currencyAlgoTicket.currencyAlgo.currency);
  assert.equal(q.mergeCoin,raw.currencyAlgoTicket.mergeCurrencyAlgo?.currency||null);
 }
 const gold=normalizePackage(fixture.teams.find(t=>t.currencyAlgoTicket.name==='Team Gold'),fixture.capturedAt,true);
 assert.equal(gold.duration,3600);assert.equal(fixture.teams.find(t=>t.id===gold.id).currencyAlgoTicket.duration,14400);
});
test('captured NiceHash rates provide USD and EUR estimates for every requested reward coin',()=>{
 const rates=normalizeRates(fixture.rates);
 for(const coin of ['BTC','BCH','LTC','DOGE','ZEC'])for(const fiat of ['USD','EUR'])assert.ok(rates.fiat[fiat][coin]>0,coin+'/'+fiat);
});
test('orphaned and donated rewards stay in the audit data and do not inflate P&L, coin quantities or daily totals',()=>{
 const now=Date.parse('2026-10-28T10:00:00Z'),at=new Date(now-1000).toISOString();
 const orders=[{id:'o',mode:'live',kind:'solo',status:'COMPLETED',strategyId:'s',costBtc:10000,feeBtc:0,createdAt:at}];
 const rewards=[{id:'valid',orderId:'o',coin:'BTC',amount:20000,valueBtc:20000,confirmed:true,createdAt:at},
  {id:'orphan',orderId:'o',coin:'BTC',amount:312500000,valueBtc:312500000,confirmed:true,confirmations:-1,createdAt:at},
  {id:'donation',orderId:'o',coin:'BCH',amount:500000000,valueBtc:900000,confirmed:false,depositDonated:true,createdAt:at}];
 assert.equal(rewards.length,3);assert.equal(rewards.filter(isRewardAccounted).length,1);
 const t=totals(orders,rewards,{mode:'live'});assert.equal(t.earned,20000);assert.equal(t.net,10000);assert.equal(t.pending,0);
 const coins=rewardSummary(orders,rewards,{mode:'live'});assert.equal(coins.find(r=>r.coin==='BTC').confirmed,20000);assert.equal(coins.find(r=>r.coin==='BCH').pending,0);
 const daily=dailyProfits(orders,rewards,{mode:'live',timezone:'Europe/Sofia',days:7,now});assert.equal(daily.total.earned,20000);assert.equal(daily.total.pending,0);
});
test('orphaned former reward does not trigger stop-on-win or unpriced reward buying hold',()=>{
 const at=new Date().toISOString(),settings={...DEFAULTS,mode:'live',running:true,liveArmed:true};
 const strategy={...STRATEGY_DEFAULTS,id:'s',enabled:true,stopOnWin:true,coin:'BTC'};
 const state={settings,runtime:{historyComplete:true,lastSync:at,balance:2000000},orders:[{id:'o',strategyId:'s',kind:'solo',mode:'live',status:'COMPLETED',costBtc:10000,createdAt:at}],rewards:[{id:'orphan',orderId:'o',coin:'BTC',amount:312500000,valueBtc:null,confirmations:-1,confirmed:true,createdAt:at}]};
 assert.equal(guard(state,strategy,{id:'new',team:false,available:true,market:'BTC',costBtc:10000,quotedAt:at}),null);
});
