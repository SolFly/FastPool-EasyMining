import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DEFAULTS,STRATEGY_DEFAULTS,units,normalizePackage,validateSettings,validateStrategy,pickQuote,guard,totals} from '../public/core.mjs';
import {fundingRecord,money,paymentMarket,ledgerProjection} from '../public/money.mjs';
import {manualQuote,manualStrategy} from '../public/purchases.mjs';
import {dailyProfits,dailyProfitCsvRows} from '../public/daily-profits.mjs';
import {normalizeRates} from '../public/rewards.mjs';
import {configurationBackup,prepareConfigurationImport} from '../public/config-backup.mjs';
import {purchaseRewardEstimate} from '../public/package-rewards.mjs';

const now=Date.now(),at=new Date(now).toISOString();
const usdtLimits={dailyCap:units('100'),weeklyCap:units('500'),monthlyCap:units('2000'),maxOrder:units('50'),reserve:0,stopLoss:0,takeProfit:0,paperBalance:units('100')};
const settings={...DEFAULTS,mode:'live',running:true,liveArmed:true,usdtLimits};
const strategy={...STRATEGY_DEFAULTS,id:'usdt',market:'USDT',coin:'BCH',packageName:'Team Silver USDT',mode:'team',kind:'team',enabled:true,minTeamShares:1,maxPrice:units('10'),budget:units('100')};
const pkg=fundingRecord('USDT',{id:'usdt-team',team:true,coin:'BCH',name:'Team Silver USDT',available:true,market:'USDT',costBtc:units('1'),price:units('1'),minShare:units('1'),teamShares:68,quotedAt:at});
const state=()=>({settings,orders:[],rewards:[],packages:[pkg],runtime:{lastSync:at,historyComplete:true,errors:0,balance:1000000,balances:{BTC:1000000,USDT:units('100')}}});

test('live NiceHash USDT catalogue prices normalize as USDT, never BTC amounts',()=>{
 const fixture=JSON.parse(readFileSync(new URL('../internal/controller/testdata/nicehash-usdt-2026-10-29.json',import.meta.url)));
 for(const [kind,rows] of [['solo',fixture.solo],['team',fixture.teams]])for(const raw of rows){const p=normalizePackage(raw,at,kind==='team');assert.equal(p.market,'USDT');assert.equal(p.costBtc,undefined);assert.ok(p.costAmount>0);assert.equal(p.costAmount,p.price);}
 assert.equal(normalizePackage(fixture.solo[0],at).costAmount,units('5'));
 assert.equal(normalizePackage(fixture.teams[0],at,true).costAmount,units('1'));
});
test('strategy selection cannot spend a BTC budget on a similarly named USDT package',()=>{
 assert.equal(pickQuote([pkg],{...strategy,market:'BTC'},[]),null);
 assert.equal(pickQuote([pkg],strategy,[]).costAmount,units('1'));
 assert.match(guard(state(),{...strategy,market:'BTC'},pkg,now),/payment market/);
});
test('USDT uses its own wallet, reserve and calendar spending caps',()=>{
 let s=state();assert.equal(guard(s,strategy,pkg,now),null);
 s.runtime.balances.USDT=0;assert.equal(guard(s,strategy,pkg,now),'Minimum wallet reserve');
 s=state();s.orders.push(fundingRecord('BTC',{id:'btc',mode:'live',status:'COMPLETED',costBtc:units('1'),createdAt:at}));
 assert.equal(guard(s,strategy,pkg,now),null);
 s.orders.push(fundingRecord('USDT',{id:'usdt',mode:'live',status:'COMPLETED',costBtc:units('100'),createdAt:at}));
 assert.equal(guard(s,strategy,pkg,now),'Daily spending cap');
});
test('an unconfigured USDT ledger blocks buying before a POST can be submitted',()=>{
 const s=state();s.settings={...DEFAULTS,mode:'live',running:true,liveArmed:true};
 assert.match(guard(s,strategy,pkg,now),/USDT spending limits are not configured/);
});
test('an uncertain USDT submission blocks all markets and retains its native amount',()=>{
 const s=state();s.orders=[fundingRecord('USDT',{id:'uncertain',mode:'live',status:'UNKNOWN',costBtc:units('5'),feeBtc:units('0.05'),createdAt:at})];
 assert.equal(s.orders[0].costBtc,undefined);assert.equal(s.orders[0].costAmount,units('5'));
 assert.match(guard(s,strategy,pkg,now),/Unresolved purchase/);
 const btc={...pkg,market:'BTC',costBtc:10000};delete btc.costAmount;
 assert.match(guard(s,{...strategy,market:'BTC'},btc,now),/Unresolved purchase/);
});
test('USDT manual review and its guard preserve payment currency and share quantities',()=>{
 const q=manualQuote([pkg],{packageId:pkg.id,shares:2},settings);
 assert.equal(q.costAmount,units('2'));assert.equal(q.costBtc,undefined);assert.equal(q.reservedAmount,units('2.02'));
 assert.equal(manualStrategy(q).market,'USDT');assert.equal(manualStrategy(q).maxPrice,units('2'));assert.equal(manualStrategy(q).continuous,false);
});
test('USDT P&L and daily exports never include unrelated BTC costs or rewards',()=>{
 const orders=[fundingRecord('USDT',{id:'u',mode:'live',status:'COMPLETED',costBtc:units('5'),feeBtc:0,refundBtc:units('1'),createdAt:at}),{id:'b',mode:'live',status:'COMPLETED',costBtc:50000,createdAt:at}];
 const rewards=[{id:'ur',orderId:'u',coin:'BCH',amount:units('1'),valueBtc:300000,valueUsdt:units('240'),confirmed:true,createdAt:at,confirmedAt:at},{id:'br',orderId:'b',coin:'BTC',amount:100000,valueBtc:100000,confirmed:true,createdAt:at}];
 assert.equal(totals(orders,rewards,{mode:'live',market:'USDT'}).net,units('236'));
 assert.equal(totals(orders,rewards,{mode:'live'}).net,50000);
 const report=dailyProfits(orders,rewards,{mode:'live',market:'USDT',now,days:0});assert.equal(report.total.net,units('236'));
 assert.ok(dailyProfitCsvRows(report).flat().some(v=>v==='Net spend USDT'));
 const projection=ledgerProjection(orders,rewards,'USDT');assert.equal(projection.rewards[0].amount,units('1'));assert.equal(orders[0].costBtc,undefined);
});
test('USDT fiat estimates use exchange rates rather than an assumed dollar peg',()=>{
 const rates=normalizeRates({list:[{fromCurrency:'USDT',toCurrency:'BTC',exchangeRate:0.000012},{fromCurrency:'BTC',toCurrency:'USD',exchangeRate:80000},{fromCurrency:'USD',toCurrency:'EUR',exchangeRate:.9}]});
 assert.ok(Math.abs(rates.fiat.USD.USDT-.96)<1e-10);assert.ok(Math.abs(rates.fiat.EUR.USDT-.864)<1e-10);
});
test('continuous mode repeats after a win and lifetime targets while global limits remain binding',()=>{
 const s=state(),st={...strategy,continuous:true,stopOnWin:true,maxPurchases:1,budget:1};
 s.orders=[fundingRecord('USDT',{id:'prior',strategyId:st.id,packageId:'old-team',mode:'live',status:'COMPLETED',costBtc:units('1'),createdAt:at})];
 s.rewards=[{id:'win',orderId:'prior',coin:'BCH',amount:1,valueBtc:1,valueUsdt:1,confirmed:true,createdAt:at}];
 assert.equal(guard(s,st,pkg,now),null);
 assert.equal(guard(s,{...st,continuous:false},pkg,now),'Purchase count reached');
 s.settings={...settings,usdtLimits:{...usdtLimits,dailyCap:units('1')}};
 assert.equal(guard(s,st,pkg,now),'Daily spending cap');
});
test('continuous mode, payment market and USDT caps survive a paused settings restore',()=>{
 const st=validateStrategy({...strategy,continuous:true,stopOnWin:true});assert.equal(st.stopOnWin,false);
 const clean=validateSettings({usdtLimits},DEFAULTS);
 const backup=configurationBackup({settings:clean,strategies:[st]});
 const plan=prepareConfigurationImport(backup,{settings:DEFAULTS,strategies:[],orders:[]},{idFactory:()=> 'id'});
 assert.equal(plan.strategies[0].market,'USDT');assert.equal(plan.strategies[0].continuous,true);assert.equal(plan.strategies[0].enabled,false);assert.equal(plan.settings.running,false);assert.deepEqual(plan.settings.usdtLimits,usdtLimits);
});
test('USDT team block estimates use native commitment and only the purchased share',()=>{
 const estimate=purchaseRewardEstimate({...pkg,teamShares:68,minShare:units('1'),teamCommitted:units('68'),blockRewards:[{coin:'BCH',amount:units('3.125')}]},1);
 assert.equal(estimate.memberAmount,units('1'));assert.equal(estimate.totalAmount,units('69'));assert.equal(estimate.fraction,1/69);
 assert.equal(estimate.blocks[0].amount,Math.floor(units('3.125')/69));
});
test('import cannot reassign an existing funded strategy to another payment currency',()=>{
 const s=state();s.strategies=[strategy];s.orders=[fundingRecord('USDT',{id:'u',strategyId:strategy.id,mode:'live',status:'COMPLETED',costBtc:units('1'),createdAt:at})];
 assert.throws(()=>prepareConfigurationImport({strategies:[{...strategy,market:'BTC'}]},s,{restoreSettings:false,idFactory:()=> 'id'}),/payment market/);
});
