import test from 'node:test';
import assert from 'node:assert/strict';
import {dailyProfits,dailyProfitCsvRows,reportingPeriod,startOfDate,calendarDate} from '../public/daily-profits.mjs';
import {totals} from '../public/core.mjs';

const now=Date.parse('2026-10-27T12:00:00Z');
const rates={at:'2026-10-27T11:00:00Z',fiat:{USD:{BTC:100000},EUR:{BTC:90000}}};
const options={mode:'live',days:7,timezone:'Europe/Sofia',now,rates};
const order=(extra={})=>({id:'owned',mode:'live',kind:'team',status:'COMPLETED',costBtc:10000,feeBtc:0,refundBtc:0,createdAt:'2026-10-26T21:59:59Z',...extra});
const reward=(extra={})=>({id:'personal',orderId:'owned',coin:'BCH',amount:76220000,valueBtc:20000,confirmed:true,createdAt:'2026-10-26T20:00:00Z',confirmedAt:'2026-10-26T22:00:00Z',...extra});
const day=(r,date)=>r.rows.find(x=>x.date===date);

test('reporting period includes today and begins at local midnight, not a rolling UTC cutoff',()=>{
  const p=reportingPeriod(7,'Europe/Sofia',now);
  assert.equal(p.fromDate,'2026-10-21');assert.equal(p.toDate,'2026-10-27');
  assert.equal(new Date(p.from).toISOString(),'2026-10-20T21:00:00.000Z');assert.equal(p.to,now);
  assert.equal(reportingPeriod(1,'Europe/Sofia',now).from,Date.parse('2026-10-26T22:00:00Z'));
});
test('calendar boundaries handle both 23-hour and 25-hour days in Sofia',()=>{
  const start=d=>startOfDate(d,'Europe/Sofia');
  assert.equal(start('2026-03-30')-start('2026-03-29'),23*3600000);
  assert.equal(start('2026-10-26')-start('2026-10-25'),25*3600000);
  assert.equal(calendarDate(start('2026-10-25')-1,'Europe/Sofia'),'2026-10-24');
  assert.equal(calendarDate(start('2026-10-25'),'Europe/Sofia'),'2026-10-25');
});
test('timezones west of UTC assign local dates without shifting labels or dropping late events',()=>{
  const p=reportingPeriod(1,'America/New_York',now);
  assert.equal(new Date(p.from).toISOString(),'2026-10-27T04:00:00.000Z');
  const r=dailyProfits([order({createdAt:'2026-10-27T03:59:59Z'})],[reward({confirmedAt:'2026-10-27T04:00:00Z'})],{...options,timezone:'America/New_York'});
  assert.equal(day(r,'2026-10-26').spend,10000);assert.equal(day(r,'2026-10-27').earned,20000);
});
test('a purchase and its later confirmation belong to separate days; pending and unpriced rewards do not inflate profit',()=>{
  const r=dailyProfits([order()],[reward(),reward({id:'pending',confirmed:false,confirmedAt:null,valueBtc:30000,createdAt:'2026-10-27T10:00:00Z'}),reward({id:'unpriced',valueBtc:null})],options);
  assert.equal(day(r,'2026-10-26').net,-10000);assert.equal(day(r,'2026-10-27').net,20000);
  assert.equal(day(r,'2026-10-27').pending,30000);assert.equal(day(r,'2026-10-27').unpriced,1);
  assert.equal(r.total.net,10000);assert.equal(r.total.pending,30000);assert.equal(r.total.unpriced,1);
  assert.equal(day(r,'2026-10-27').usd,20);assert.equal(day(r,'2026-10-27').eur,18);
});
test('team additions and refunds use incremental history once, and only accepted or unresolved buys count',()=>{
  const o=order({costBtc:30000,refundBtc:5000,createdAt:'2026-10-25T10:00:00Z',
    spendHistory:[{at:'2026-10-25T10:00:00Z',amountBtc:10000},{at:'2026-10-26T10:00:00Z',amountBtc:20000},{at:'2026-10-27T10:00:00Z',amountBtc:-5000}],
    teamBuys:[{status:'CONFIRMED',createdAt:'2026-10-25T10:00:00Z'},{status:'PENDING',createdAt:'2026-10-26T10:00:00Z'},{status:'REJECTED',createdAt:'2026-10-27T10:00:00Z'}]});
  const r=dailyProfits([o],[reward({valueBtc:15000})],options);
  assert.equal(day(r,'2026-10-25').spend,10000);assert.equal(day(r,'2026-10-26').spend,20000);assert.equal(day(r,'2026-10-27').spend,-5000);
  assert.equal(r.total.spend,25000);assert.equal(r.total.earned,15000);assert.equal(r.total.net,-10000);assert.equal(r.total.purchases,2);
  const t=totals([o],[reward({valueBtc:15000})],{mode:'live',from:r.from,to:r.to});
  for(const key of ['spend','earned','net','pending','unpriced'])assert.equal(r.total[key],t[key]);assert.equal(r.total.purchases,t.count);
});
test('today includes an addition to a team first purchased before the selected period',()=>{
  const o=order({costBtc:30000,createdAt:'2026-09-01T10:00:00Z',spendHistory:[{at:'2026-09-01T10:00:00Z',amountBtc:10000},{at:'2026-10-27T10:00:00Z',amountBtc:20000}],teamBuys:[{status:'CONFIRMED',createdAt:'2026-09-01T10:00:00Z'},{status:'UNKNOWN',createdAt:'2026-10-27T10:00:00Z'}]});
  const r=dailyProfits([o],[reward()],options);assert.equal(r.total.spend,20000);assert.equal(r.total.purchases,1);assert.equal(r.total.earned,20000);
});
test('rejected attempts, ownership holds, superseded duplicates and the other execution mode stay excluded',()=>{
  const orders=[order(),order({id:'failed',status:'FAILED'}),order({id:'rejected',status:'REJECTED'}),order({id:'held',attribution:{state:'review'}}),order({id:'old',supersededBy:'owned'}),order({id:'old-status',status:'SUPERSEDED'}),order({id:'paper',mode:'paper'})];
  const rewards=[reward(),...['held','old','old-status','paper'].map(id=>reward({id,orderId:id})),reward({id:'duplicate-reward',supersededBy:'personal'})];
  const r=dailyProfits(orders,rewards,options);assert.equal(r.total.spend,10000);assert.equal(r.total.earned,20000);assert.equal(r.total.purchases,1);
});
test('old imports use stored first-observed confirmation and legacy fallback without changing the source ledger',()=>{
  const orders=[order({createdAt:'2026-09-01T12:00:00Z'})],rewards=[reward({createdAt:'2026-09-02T12:00:00Z'}),reward({id:'legacy',confirmedAt:null,createdAt:'2026-10-25T12:00:00Z',valueBtc:5000})];
  const before=JSON.stringify({orders,rewards});const r=dailyProfits(orders,rewards,options);
  assert.equal(day(r,'2026-10-27').earned,20000);assert.equal(day(r,'2026-10-25').earned,5000);assert.equal(r.total.legacyConfirmations,1);
  assert.equal(JSON.stringify({orders,rewards}),before);assert.deepEqual(dailyProfits(orders,rewards,options),r);
});
test('a pending reward moves to its later confirmation day without remaining in pending or being counted twice',()=>{
  const pending=reward({confirmed:false,confirmedAt:null,createdAt:'2026-10-25T12:00:00Z'});
  const before=dailyProfits([order()],[pending],options);assert.equal(day(before,'2026-10-25').pending,20000);assert.equal(before.total.earned,0);
  const after=dailyProfits([order()],[{...pending,confirmed:true,confirmedAt:'2026-10-27T10:00:00Z'}],options);
  assert.equal(day(after,'2026-10-25').pending,0);assert.equal(day(after,'2026-10-27').earned,20000);assert.equal(after.total.pending,0);assert.equal(after.total.earned,20000);
});
test('days without activity are zero-filled and all-time includes an empty current day',()=>{
  const r=dailyProfits([],[],options);assert.equal(r.rows.length,7);assert.equal(r.total.net,0);assert.ok(r.rows.every(x=>x.spend===0&&x.earned===0));
  const all=dailyProfits([],[],{...options,days:0});assert.equal(all.rows.length,1);assert.equal(all.fromDate,'2026-10-27');
  const nonempty=dailyProfits([order({createdAt:'2026-10-25T10:00:00Z'})],[],{...options,days:0});assert.equal(nonempty.rows.length,3);assert.equal(nonempty.rows.at(-1).net,0);
});
test('undated and future events are not fabricated into today; invalid timestamps remain reported',()=>{
  const r=dailyProfits([order({createdAt:'bad'})],[reward({confirmedAt:'bad'}),reward({id:'future',confirmedAt:'2026-10-28T12:00:00Z'})],options);
  assert.equal(r.total.net,0);assert.ok(r.undated>0);assert.equal(r.rows.length,7);
});
test('reserved fees and unknown purchases match the existing conservative ledger, not a second debit',()=>{
  const r=dailyProfits([order({status:'UNKNOWN',feeBtc:1000})],[],options);
  assert.equal(r.total.spend,11000);assert.equal(r.total.net,-11000);assert.equal(r.total.purchases,1);
});
test('CSV covers every day and includes the same totals, timezone, valuation method and missing-price flags',()=>{
  const r=dailyProfits([order()],[reward(),reward({id:'unknown',confirmed:false,valueBtc:null})],options),csv=dailyProfitCsvRows(r,rates);
  assert.equal(csv.filter(row=>/^2026-/.test(row[0])).length,7);
  assert.ok(csv.some(row=>row.includes('Europe/Sofia')));assert.ok(csv.some(row=>row.includes(rates.at)));
  const total=csv.at(-1);assert.equal(total[0],'TOTAL');assert.equal(total[4],'0.00010000');assert.equal(total[5],'10.00');assert.equal(total[6],'9.00');assert.equal(total[9],1);
  const noRates=dailyProfits([order()],[reward()],{...options,rates:null});assert.equal(noRates.total.usd,null);assert.equal(dailyProfitCsvRows(noRates).at(-1)[5],'UNPRICED');
});
test('invalid reporting windows are rejected instead of producing misleading totals',()=>{
  for(const value of [-1,1.5,Infinity,4000,NaN])assert.throws(()=>reportingPeriod(value,'UTC',now),/calendar days/);
  assert.throws(()=>reportingPeriod(7,'MadeUp/Zone',now),/time zone/i);assert.throws(()=>reportingPeriod(7,'UTC',NaN),/reporting time/);
});
