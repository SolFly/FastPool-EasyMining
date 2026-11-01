import test from 'node:test';
import assert from 'node:assert/strict';
import {strategyProgress} from '../public/strategy-progress.mjs';
import {units} from '../public/core.mjs';
import {fundingRecord} from '../public/money.mjs';

const at='2026-10-30T08:00:00Z';
const strategy={id:'silver',market:'BTC',continuous:true,budget:units('0.002'),maxPurchases:20};
const order=extra=>({id:'o',strategyId:'silver',mode:'live',kind:'team',status:'COMPLETED',costBtc:units('0.0001'),createdAt:at,...extra});

test('continuous buying shows actual budget and purchase progress beyond both saved targets',()=>{
  const orders=Array.from({length:22},(_,i)=>order({id:String(i)}));
  const p=strategyProgress(strategy,orders,'live');
  assert.equal(p.budget.used,units('0.0022'));assert.equal(p.budget.target,units('0.002'));
  assert.ok(Math.abs(p.budget.percent-110)<1e-10);assert.equal(p.budget.width,100);
  assert.equal(p.purchases.used,22);assert.equal(p.purchases.target,20);assert.equal(p.purchases.width,100);
  assert.deepEqual(p,strategyProgress({...strategy,continuous:false},orders,'live'));
});

test('progress uses net spend with fees/refunds and counts accepted team additions once',()=>{
  const orders=[order({costBtc:units('0.0003'),feeBtc:units('0.00001'),refundBtc:units('0.0001'),teamBuys:[{status:'CONFIRMED',createdAt:at},{status:'FAILED',createdAt:at},{status:'CONFIRMED',createdAt:at}]}),
    order({id:'failed',status:'FAILED'}),order({id:'superseded',status:'SUPERSEDED'}),order({id:'held',attribution:{state:'review'}})];
  const p=strategyProgress(strategy,orders,'live');
  assert.equal(p.budget.used,units('0.00021'));assert.equal(p.purchases.used,2);
});

test('BTC and USDT progress are scoped to the strategy, execution mode and payment currency',()=>{
  const usdt={...strategy,market:'USDT',budget:units('100')};
  const orders=[fundingRecord('USDT',order({costBtc:units('25')})),order({id:'btc'}),
    fundingRecord('USDT',order({id:'paper',mode:'paper',costBtc:units('90')})),
    fundingRecord('USDT',order({id:'other',strategyId:'other',costBtc:units('80')}))];
  const p=strategyProgress(usdt,orders,'live');
  assert.equal(p.market,'USDT');assert.equal(p.budget.used,units('25'));assert.equal(p.budget.percent,25);assert.equal(p.purchases.used,1);
  assert.equal(strategyProgress(strategy,orders,'live').budget.used,units('0.0001'));
});

test('empty activity and missing legacy targets do not produce invalid progress widths',()=>{
  const p=strategyProgress({id:'legacy',market:'BTC'},[],'live');
  assert.equal(p.budget.used,0);assert.equal(p.budget.percent,null);assert.equal(p.budget.width,0);
  assert.equal(p.purchases.used,0);assert.equal(p.purchases.width,0);
});
