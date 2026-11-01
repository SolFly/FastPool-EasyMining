import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRates,fiatValue,rewardSummary,ratesStale} from '../public/rewards.mjs';
import {normalizePackage,validateStrategy} from '../public/core.mjs';
const rates=()=>normalizeRates({list:[{fromCurrency:'BTC',toCurrency:'USD',exchangeRate:'100000'},{fromCurrency:'USD',toCurrency:'EUR',exchangeRate:'.9'},{fromCurrency:'LTC',toCurrency:'USD',exchangeRate:'80'},{fromCurrency:'DOGE',toCurrency:'USD',exchangeRate:'.1'}]},'2026-10-26T12:00:00Z');
test('fiat conversion uses coin quantity, direct or cross rates and never treats missing rates as zero',()=>{
 const r=rates();assert.equal(fiatValue(200000000,'LTC','USD',r),160);assert.equal(fiatValue(200000000,'LTC','EUR',r),144);
 assert.equal(fiatValue(100000000,'BTC','EUR',r),90000);assert.equal(fiatValue(100000000,'ZEC','USD',r),null);
 assert.equal(fiatValue(null,'BTC','USD',r),null);assert.equal(fiatValue(500000000,'DOGE','USD',r),.5);
 assert.equal(r.btc.LTC,.0008);
});
test('per-coin reward summary separates pending and confirmed, respects mode and dates and includes all five requested coins',()=>{
 const orders=[{id:'live',mode:'live'},{id:'paper',mode:'paper'}],rewards=[
 {orderId:'live',coin:'LTC',amount:200000000,confirmed:true,valueBtc:1,createdAt:'2026-10-26T10:00:00Z'},
 {orderId:'live',coin:'DOGE',amount:10000000000,confirmed:false,createdAt:'2026-10-26T10:00:00Z'},
 {orderId:'paper',coin:'LTC',amount:100000000,confirmed:true,createdAt:'2026-10-26T10:00:00Z'},
 {orderId:'live',coin:'LTC',amount:100000000,confirmed:true,createdAt:'2026-10-20T10:00:00Z'}];
 const before=JSON.stringify(rewards),summary=rewardSummary(orders,rewards,{mode:'live',from:Date.parse('2026-10-25')},rates());
 assert.deepEqual(summary.map(r=>r.coin),['BTC','BCH','LTC','DOGE','ZEC']);
 assert.equal(summary[2].confirmed,200000000);assert.equal(summary[2].usd,160);assert.equal(summary[2].eur,144);
 assert.equal(summary[3].confirmed,0);assert.equal(summary[3].pending,10000000000);assert.equal(summary[3].usd,0);
 assert.equal(JSON.stringify(rewards),before);
});
test('invalid rates are excluded and stale estimates are identified',()=>{
 const r=normalizeRates({list:[{fromCurrency:'BTC',toCurrency:'USD',exchangeRate:'NaN'},{fromCurrency:'LTC',toCurrency:'USD',exchangeRate:-4}]});
 assert.equal(fiatValue(100000000,'BTC','USD',r),null);assert.equal(ratesStale(rates(),Date.parse('2026-10-26T12:16:00Z')),true);
 assert.equal(ratesStale(rates(),Date.parse('2026-10-26T12:05:00Z')),false);assert.equal(ratesStale(null),true);
});
test('package normalization preserves merged reward coin and strategies validate payout addresses',()=>{
 const p=normalizePackage({id:'p',price:.0001,available:true,currencyAlgo:{currency:'LTC'},mergeCurrencyAlgo:{currency:'DOGE'}});
 assert.equal(p.mergeCoin,'DOGE');assert.throws(()=>validateStrategy({payoutAddress:'contains spaces'}),/payout address/);
 assert.equal(validateStrategy({payoutAddress:'  ltc1qexampledestination00000  ',mergePayoutAddress:'DExampleDestination00000'}).payoutAddress,'ltc1qexampledestination00000');
});
