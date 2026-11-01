import {ledgerProjection} from './money.mjs';
import {decimal,isAccounted,isFunded,spendEntries,isRewardAccounted} from './core.mjs';
import {fundedLevel} from './team-levels.mjs';
import {fiatValue} from './rewards.mjs';

const formatters=new Map();
const boundaries=new Map();
export function calendarDate(value,timezone='Europe/Sofia'){
  if(!formatters.has(timezone))formatters.set(timezone,new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}));
  const p=Object.fromEntries(formatters.get(timezone).formatToParts(new Date(value)).map(x=>[x.type,x.value]));
  return p.year+'-'+p.month+'-'+p.day;
}
export function shiftDate(date,days){
  const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);
}
// Find the calendar boundary, rather than subtracting 24 hours. DST days can
// have 23 or 25 hours; some zones also change offset at midnight.
export function startOfDate(date,timezone='Europe/Sofia'){
  const key=timezone+'/'+date;if(boundaries.has(key))return boundaries.get(key);
  const noon=Date.parse(date+'T12:00:00Z');let low=noon-48*3600000,high=noon+48*3600000;
  while(low<high){const mid=Math.floor((low+high)/2);if(calendarDate(mid,timezone)<date)low=mid+1;else high=mid;}
  boundaries.set(key,low);return low;
}
export function reportingPeriod(days=30,timezone='Europe/Sofia',now=Date.now()){
  if(!Number.isInteger(days)||days<0||days>3660)throw new Error('Choose 0–3660 calendar days');
  if(!Number.isFinite(now)||now<0)throw new Error('Invalid reporting time');
  const today=calendarDate(now,timezone),fromDate=days?shiftDate(today,1-days):null;
  return {from:fromDate?startOfDate(fromDate,timezone):0,to:now,fromDate,toDate:today,timezone,days};
}
const empty=date=>({date,purchases:0,spend:0,earned:0,net:0,pending:0,unpriced:0,pendingUnpriced:0,legacyConfirmations:0});
const fields=['purchases','spend','earned','net','pending','unpriced','pendingUnpriced','legacyConfirmations'];

export function dailyProfits(orders,rewards,{mode='paper',timezone='Europe/Sofia',days=30,now=Date.now(),rates,market='BTC'}={}){
  ({orders,rewards}=ledgerProjection(orders,rewards,market));
  const period=reportingPeriod(days,timezone,now),buckets=new Map();let undated=0;
  const bucket=timestamp=>{
    const time=Date.parse(timestamp);
    if(!Number.isFinite(time)){undated++;return null;}
    if(time<period.from||time>period.to)return null;
    const key=calendarDate(time,timezone);if(!buckets.has(key))buckets.set(key,empty(key));return buckets.get(key);
  };
  const selected=orders.filter(o=>isAccounted(o)&&o.mode===mode),ids=new Set(selected.map(o=>o.id));
  for(const order of selected.filter(isFunded)){
    for(const entry of spendEntries(order)){const row=bucket(entry.at);if(row)row.spend+=entry.amountBtc;}
    const buys=order.teamBuys?.length?order.teamBuys:[{status:order.status,createdAt:order.createdAt}];
    for(const buy of buys.filter(fundedLevel)){const row=bucket(buy.createdAt);if(row)row.purchases++;}
  }
  for(const reward of rewards.filter(r=>isRewardAccounted(r)&&ids.has(r.orderId))){
    const row=bucket(reward.confirmedAt||reward.createdAt);if(!row)continue;
    if(Number.isSafeInteger(reward.valueBtc))row[reward.confirmed?'earned':'pending']+=reward.valueBtc;
    else row[reward.confirmed?'unpriced':'pendingUnpriced']++;
    if(reward.confirmed&&!reward.confirmedAt)row.legacyConfirmations++;
  }
  // All-time starts with the first dated ledger event, not thousands of empty
  // days since 1970. Normal periods include every local day, even with no buys.
  const fromDate=period.fromDate||[...buckets.keys()].sort()[0]||period.toDate,rows=[];
  for(let day=fromDate;day<=period.toDate;day=shiftDate(day,1)){
    const row=buckets.get(day)||empty(day);row.net=row.earned-row.spend;
    row.usd=fiatValue(row.net,market,'USD',rates);row.eur=fiatValue(row.net,market,'EUR',rates);rows.push(row);
  }
  const total=empty(null);for(const row of rows)for(const key of fields)total[key]+=row[key];
  total.usd=fiatValue(total.net,market,'USD',rates);total.eur=fiatValue(total.net,market,'EUR',rates);
  return {...period,fromDate,mode,market,rows,total,undated};
}

export function dailyProfitCsvRows(report,rates){
  const market=report.market||'BTC';
  const value=n=>n===null?'UNPRICED':n.toFixed(2);
  const rows=[
    ['Daily profit and loss','Mode',report.mode,'Timezone',report.timezone],
    ['From local date',report.fromDate,'Through local date',report.toDate,'As of',new Date(report.to).toISOString()],
    ['Method','Confirmed reward BTC value minus net package spend, including reserved fees. Pending rewards excluded.'],
    ['Dates','Purchases and spend changes use saved event times. Rewards use first observed confirmation; legacy records use saved reward time.'],
    ['Fiat','Current BTC spot estimates, not historical exchange proceeds.','Spot timestamp',rates?.at||'UNAVAILABLE'],
    ['Undated entries excluded',report.undated],
    ['Date','Purchases / team additions','Net spend BTC','Confirmed reward value BTC','Net P&L BTC','Net P&L USD estimate','Net P&L EUR estimate','Pending reward value BTC','Unpriced confirmed rewards','Unpriced pending rewards'],
    ...report.rows.map(r=>[r.date,r.purchases,decimal(r.spend),decimal(r.earned),decimal(r.net),value(r.usd),value(r.eur),decimal(r.pending),r.unpriced,r.pendingUnpriced]),
    ['TOTAL',report.total.purchases,decimal(report.total.spend),decimal(report.total.earned),decimal(report.total.net),value(report.total.usd),value(report.total.eur),decimal(report.total.pending),report.total.unpriced,report.total.pendingUnpriced]
  ];
  return market==='BTC'?rows:rows.map(row=>row.map(v=>typeof v==='string'?v.replaceAll('BTC',market):v));
}
