import {MARKETS,USDT_LIMITS,paymentMarket,money,fundingRecord,marketLimits,marketBalance,ledgerProjection,orderView} from './money.mjs';
import {orderSyncBlocksBuying} from './sync-status.mjs';
import {purchaseProfile} from './request-profiles.mjs';
import {providerUnits} from './provider-amounts.mjs';
import {catalogueBlockRewards} from './package-rewards.mjs';
import {rejectedTeamTarget,rejectedTeamReason,TEAM_STATE_REJECTED_REASON} from './purchase-status.mjs';
import {levelBuying,validateTeamLevels,nextTeamLevel,purchaseCount} from './team-levels.mjs';
export const VERSION = '2.2.5-go';
export const SAT = 100000000;
export function units(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid monetary amount');
    value = value.toFixed(8);
  }
  if (!/^-?\d+(\.\d{1,8})?$/.test(String(value))) throw new Error('Use a decimal amount with up to 8 places');
  const neg = String(value).startsWith('-');
  const [a,b=''] = String(value).replace('-','').split('.');
  const n = BigInt(a)*100000000n+BigInt(b.padEnd(8,'0'));
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount too large');
  return Number(n)*(neg?-1:1);
}
export const decimal = n => (n/SAT).toFixed(8);
export const DEFAULTS = Object.freeze({
  purchaseRequestProfile:'documented', usdtLimits:USDT_LIMITS, mode:'paper', running:false, liveArmed:false, dailyCap:units('0.001'), weeklyCap:units('0.005'),
  monthlyCap:units('0.015'), maxOrder:units('0.001'), reserve:units('0.001'),
  stopLoss:units('0.003'), takeProfit:units('0.01'), maxActive:3, maxErrors:3,
  pollSeconds:60, autoSync:true, accountSyncSeconds:60, timezone:'Europe/Sofia', paperBalance:units('0.02'),
  feeBufferBps:100, displayCurrency:'BTC', startHour:'00:00', endHour:'23:59'
});
export const STRATEGY_DEFAULTS = Object.freeze({
  name:'New strategy', market:'BTC', continuous:true, enabled:false, kind:'interval', mode:'solo', coin:'BTC',
  packageName:'Gold S', packageId:'', intervalMinutes:60, shares:1,
  maxPrice:units('0.0001'), budget:units('0.001'), maxPurchases:10,
  minTeamShares:50, teamLevels:Object.freeze([]), maxOdds:50000, stopOnWin:false, startHour:'00:00', endHour:'23:59',
  days:[0,1,2,3,4,5,6], lastBuyAt:null, createdAt:new Date().toISOString()
});
export function payoutAddress(value='') {
  const address=String(value).trim();
  if(address&&!/^[A-Za-z0-9:._-]{14,200}$/.test(address))throw new Error('Enter a valid payout address without spaces (14–200 characters)');
  return address;
}
export function payoutFields(input={}) {
  return {payoutAddress:payoutAddress(input.payoutAddress||''),mergePayoutAddress:payoutAddress(input.mergePayoutAddress||'')};
}
export function validateSettings(input, prior=DEFAULTS) {
  const s={...prior};
  if(input.usdtLimits!==undefined){
    if(!input.usdtLimits||typeof input.usdtLimits!=='object'||Array.isArray(input.usdtLimits))throw new Error('USDT limits must be an object');
    const limits={...USDT_LIMITS,...prior.usdtLimits};
    for(const k of Object.keys(USDT_LIMITS))if(input.usdtLimits[k]!==undefined){if(!Number.isSafeInteger(input.usdtLimits[k])||input.usdtLimits[k]<0)throw new Error('Invalid USDT '+k);limits[k]=input.usdtLimits[k];}
    if(limits.maxOrder>limits.dailyCap||limits.dailyCap>limits.weeklyCap||limits.weeklyCap>limits.monthlyCap)throw new Error('USDT caps must increase from order to daily, weekly and monthly');
    s.usdtLimits=limits;
  }
  for(const k of ['dailyCap','weeklyCap','monthlyCap','maxOrder','reserve','stopLoss','takeProfit','paperBalance']) {
    if(input[k]!==undefined){if(!Number.isSafeInteger(input[k])||input[k]<0)throw new Error(k+' must be a nonnegative amount');s[k]=input[k];}
  }
  for(const [k,min,max] of [['maxActive',1,100],['maxErrors',1,100],['pollSeconds',30,3600],['accountSyncSeconds',30,3600],['feeBufferBps',0,1000]]){
    if(input[k]!==undefined){if(!Number.isInteger(input[k])||input[k]<min||input[k]>max)throw new Error(k+' must be '+min+'–'+max);s[k]=input[k];}
  }
  if(input.timezone){new Intl.DateTimeFormat('en',{timeZone:input.timezone});s.timezone=input.timezone;}
  if(input.purchaseRequestProfile!==undefined){if(!['documented','web','guide'].includes(input.purchaseRequestProfile))throw new Error('Invalid purchase request format');s.purchaseRequestProfile=input.purchaseRequestProfile;}
  if(input.mode!==undefined){if(!['paper','live'].includes(input.mode))throw new Error('Invalid mode');s.mode=input.mode;}
  if(input.displayCurrency!==undefined){if(!['BTC','USD','EUR'].includes(input.displayCurrency))throw new Error('Invalid display currency');s.displayCurrency=input.displayCurrency;}
  for(const k of ['startHour','endHour'])if(input[k]!==undefined){if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(input[k]))throw new Error('Invalid time');s[k]=input[k];}
  if(input.running!==undefined)s.running=!!input.running;
  if(input.autoSync!==undefined){if(typeof input.autoSync!=='boolean')throw new Error('autoSync must be true or false');s.autoSync=input.autoSync;}
  if(s.maxOrder<=0||s.dailyCap<=0||s.weeklyCap<=0||s.monthlyCap<=0)throw new Error('Spending caps must be positive');
  if(s.maxOrder>s.dailyCap)throw new Error('Order cap exceeds daily cap');
  if(s.dailyCap>s.weeklyCap||s.weeklyCap>s.monthlyCap)throw new Error('Caps must increase from daily to monthly');
  return s;
}
export function validateStrategy(input, prior=STRATEGY_DEFAULTS) {
  const s={...prior};
  for(const k of ['payoutAddress','mergePayoutAddress'])if(input[k]!==undefined)s[k]=payoutAddress(input[k]);
  for(const k of ['name','packageName','packageId','coin'])if(input[k]!==undefined)s[k]=String(input[k]).trim().slice(0,120);
  if(!s.name)throw new Error('Give the strategy a name');
  for(const [k,choices] of [['market',MARKETS],['kind',['interval','price','odds','team']],['mode',['solo','team']]])if(input[k]!==undefined){if(!choices.includes(input[k]))throw new Error('Invalid '+k);s[k]=input[k];}
  for(const [k,min,max] of [['intervalMinutes',1,43200],['shares',1,100],['maxPurchases',1,100000],['minTeamShares',0,100000],['maxOdds',1,1000000000]]){
    if(input[k]!==undefined){if(!Number.isInteger(input[k])||input[k]<min||input[k]>max)throw new Error('Invalid '+k);s[k]=input[k];}
  }
  for(const k of ['maxPrice','budget'])if(input[k]!==undefined){if(!Number.isSafeInteger(input[k])||input[k]<=0)throw new Error('Invalid '+k);s[k]=input[k];}
  if(input.continuous!==undefined)s.continuous=!!input.continuous;
  if(!s.continuous&&s.budget<s.maxPrice)throw new Error('Strategy budget must cover at least one purchase');
  for(const k of ['enabled','stopOnWin'])if(input[k]!==undefined)s[k]=!!input[k];if(s.continuous)s.stopOnWin=false;
  for(const k of ['startHour','endHour'])if(input[k]!==undefined){if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(input[k]))throw new Error('Invalid time');s[k]=input[k];}
  if(input.days!==undefined){if(!Array.isArray(input.days)||!input.days.length||input.days.some(x=>!Number.isInteger(x)||x<0||x>6))throw new Error('Select valid weekdays');s.days=[...new Set(input.days)];}
  if(s.kind==='team')s.mode='team';
  if(input.teamLevels!==undefined)s.teamLevels=validateTeamLevels(input.teamLevels);
  if(s.teamLevels?.length&&s.mode!=='team')throw new Error('Buying levels require team packages');
  return s;
}
export function localParts(now,timezone) {
  const f=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const o=Object.fromEntries(f.formatToParts(new Date(now)).map(x=>[x.type,x.value]));
  const date=o.year+'-'+o.month+'-'+o.day;
  return {date,time:o.hour+':'+o.minute,day:new Date(date+'T12:00:00Z').getUTCDay(),month:date.slice(0,7)};
}
export function inWindow(time,start,end) {return start<=end?(time>=start&&time<=end):(time>=start||time<=end);}
export const isRewardAccounted = r => !r.supersededBy&&!r.excludedFromAccounting&&r.confirmations!==-1&&!r.depositDonated;
export const isCurrent = o => !o.supersededBy&&o.status!=='SUPERSEDED';
export const attributionHeld = o => o.attribution?.state==='review';
export const isAccounted = o => isCurrent(o)&&!attributionHeld(o);
export const isPending = o => isCurrent(o)&&['ACTIVE','PENDING','SUBMITTING','UNKNOWN'].includes(o.status);
export const isFunded = o => isCurrent(o)&&!['FAILED','REJECTED'].includes(o.status);
export function spendEntries(order){
  const total=money(order,'costBtc')+money(order,'feeBtc')-money(order,'refundBtc'),history=order.spendHistory?.map(e=>({...e,amountBtc:money(e,'amountBtc')}));
  if(Array.isArray(history)&&history.length&&history.every(e=>Number.isSafeInteger(e.amountBtc)&&Number.isFinite(Date.parse(e.at)))&&history.reduce((n,e)=>n+e.amountBtc,0)===total)return history;
  return [{at:order.createdAt,amountBtc:total}];
}
export function totals(orders,rewards,{mode='paper',from=0,to=Infinity,strategyId=null,market='BTC'}={}) {
  ({orders,rewards}=ledgerProjection(orders,rewards,market));
  const selected=orders.filter(o=>isCurrent(o)&&o.mode===mode&&(!strategyId||o.strategyId===strategyId));
  const all=selected.filter(o=>!attributionHeld(o)),review=selected.filter(attributionHeld);
  const os=all.filter(o=>Date.parse(o.createdAt)>=from&&Date.parse(o.createdAt)<=to);
  const ids=new Set(all.map(o=>o.id));
  const rs=rewards.filter(r=>isRewardAccounted(r)&&ids.has(r.orderId)&&Date.parse(r.confirmedAt||r.createdAt)>=from&&Date.parse(r.confirmedAt||r.createdAt)<=to);
  const spend=all.filter(isFunded).flatMap(spendEntries).filter(e=>Date.parse(e.at)>=from&&Date.parse(e.at)<=to).reduce((n,e)=>n+e.amountBtc,0);
  const earned=rs.filter(r=>r.confirmed&&Number.isSafeInteger(r.valueBtc)).reduce((n,r)=>n+r.valueBtc,0);
  const pending=rs.filter(r=>!r.confirmed&&Number.isSafeInteger(r.valueBtc)).reduce((n,r)=>n+r.valueBtc,0);
  const settled=os.filter(o=>o.status==='COMPLETED');
  const settledIds=new Set(settled.map(o=>o.id));
  const settledCost=settled.reduce((n,o)=>n+o.costBtc+(o.feeBtc||0)-(o.refundBtc||0),0);
  const settledEarned=rs.filter(r=>settledIds.has(r.orderId)&&r.confirmed&&Number.isSafeInteger(r.valueBtc)).reduce((n,r)=>n+r.valueBtc,0);
  const wins=new Set(rs.filter(r=>r.confirmed&&r.amount>0).map(r=>r.orderId));
  return {spend,earned,pending,net:earned-spend,settledNet:settledEarned-settledCost,
    roi:spend?(earned-spend)/spend*100:null,count:all.filter(isFunded).reduce((n,o)=>n+purchaseCount(o,from,to),0),
    active:os.filter(isPending).length,settled:settled.length,wins:[...wins].filter(id=>settledIds.has(id)).length,
    winRate:settled.length?[...wins].filter(id=>settledIds.has(id)).length/settled.length*100:null,
    exposure:os.filter(isPending).reduce((n,o)=>n+o.costBtc+(o.feeBtc||0),0),
    unpriced:rs.filter(r=>r.confirmed&&!Number.isSafeInteger(r.valueBtc)).length,reviewCount:review.length,
    reviewCost:review.filter(isFunded).reduce((n,o)=>n+o.costBtc+(o.feeBtc||0)-(o.refundBtc||0),0)};
}
export function guard(state,strategy,quote,now=Date.now(),{manual=false}={}) {
  const market=paymentMarket(strategy),s=marketLimits(state.settings,market),mode=s.mode;
  const orders=state.orders.filter(o=>isCurrent(o)&&o.mode===mode), rs=state.rewards.filter(r=>isRewardAccounted(r));
  const local=localParts(now,s.timezone), os=orders.filter(o=>isFunded(o)&&paymentMarket(o)===market).map(orderView);
  if(!manual&&!s.running)return 'Engine is paused';
  if(!strategy.enabled)return 'Strategy is paused';
  if(mode==='live'&&orders.some(attributionHeld))return 'Imported purchase ownership is being verified; account sync will retry';
  if(state.runtime?.errors>=s.maxErrors)return 'API error circuit breaker';
  if(orders.some(o=>['UNKNOWN','SUBMITTING'].includes(o.status)))return 'Unresolved purchase: reconcile before buying';
  if(mode==='live'&&!s.liveArmed)return 'Live buying is not armed';
  if(mode==='live'&&orders.some(orderSyncBlocksBuying))return 'Waiting for NiceHash order details; account sync will retry';
  if(mode==='live'&&state.runtime?.buyingReady!==true&&(manual?state.runtime?.historyComplete!==true:state.runtime?.historyComplete===false))return 'Account history is incomplete; review sync warnings before buying';
  if(mode==='live'&&(!state.runtime?.lastSync||now-Date.parse(state.runtime.lastSync)>180000))return 'Account data is stale';
  if(!inWindow(local.time,s.startHour,s.endHour)||!inWindow(local.time,strategy.startHour,strategy.endHour)||!strategy.days.includes(local.day))return 'Outside buying schedule';
  const profile=purchaseProfile(s);
  if(!quote||!quote.available){
    if(!quote){
      const matching=(state.packages||[]).filter(p=>strategy.mode==='team'&&p.team&&p.coin===strategy.coin&&paymentMarket(p)===market&&(strategy.packageId?p.id===strategy.packageId:(!strategy.packageName||p.name.toLowerCase()===strategy.packageName.toLowerCase())));
      const rejected=matching.map(p=>rejectedTeamReason(orders,p.id,profile)).find(Boolean);if(rejected)return rejected;
      if(profile==='guide'&&levelBuying(strategy)&&matching.some(p=>nextTeamLevel(p,strategy,orders)?.parentOrderId))return 'The guide shares-only format supports first joins; cumulative additions require the documented or web format';
      if(levelBuying(strategy))return 'No current team has an unfilled buying level';
    }
    return 'Package unavailable';
  }
  if(mode==='live'&&quote.team&&rejectedTeamTarget(orders,quote.id,profile)){const reason=rejectedTeamReason(orders,quote.id,profile);return reason===TEAM_STATE_REJECTED_REASON?reason:'This team lobby was rejected as unavailable; choose a current matching team';}
  if(!quote.quotedAt||now-Date.parse(quote.quotedAt)>120000)return 'Package quote is stale';
  if(!MARKETS.includes(quote.market)||paymentMarket(quote)!==market)return 'Package payment market does not match the strategy';
  if(!s.dailyCap||!s.maxOrder)return market+' spending limits are not configured';
  const cost=money(quote,'costBtc'), reserve=cost+Math.ceil(cost*s.feeBufferBps/10000);
  if(!Number.isSafeInteger(cost)||cost<=0)return 'Invalid package price';
  if(cost>strategy.maxPrice||reserve>s.maxOrder)return 'Price exceeds purchase ceiling';
  const own=os.filter(o=>o.strategyId===strategy.id);
  if(!strategy.continuous&&own.reduce((n,o)=>n+purchaseCount(o),0)>=strategy.maxPurchases)return 'Purchase count reached';
  if(!strategy.continuous&&own.reduce((n,o)=>n+o.costBtc+(o.feeBtc||0)-(o.refundBtc||0),0)+reserve>strategy.budget)return 'Strategy budget reached';
  const parent=quote.parentOrderId&&orders.find(o=>o.id===quote.parentOrderId);
  if(orders.filter(isPending).length>=s.maxActive&&!(parent&&isPending(parent)))return 'Concurrent package limit';
  const spending=os.flatMap(spendEntries);
  const daySpend=spending.filter(e=>localParts(e.at,s.timezone).date===local.date).reduce((n,e)=>n+e.amountBtc,0);
  const weekStart=new Date(local.date+'T00:00:00Z');weekStart.setUTCDate(weekStart.getUTCDate()-((weekStart.getUTCDay()+6)%7));
  const weekDate=weekStart.toISOString().slice(0,10);
  const weekSpend=spending.filter(e=>localParts(e.at,s.timezone).date>=weekDate).reduce((n,e)=>n+e.amountBtc,0);
  const monthSpend=spending.filter(e=>localParts(e.at,s.timezone).month===local.month).reduce((n,e)=>n+e.amountBtc,0);
  if(daySpend+reserve>s.dailyCap)return 'Daily spending cap';
  if(weekSpend+reserve>s.weeklyCap)return 'Weekly spending cap';
  if(monthSpend+reserve>s.monthlyCap)return 'Monthly spending cap';
  const t=totals(orders,rs,{mode,market});
  if(s.stopLoss>0&&t.net<=-s.stopLoss)return 'Stop loss reached';
  if(s.takeProfit>0&&t.net>=s.takeProfit)return 'Take profit reached';
  if(mode==='live'&&t.unpriced)return 'Unvalued confirmed rewards: reconcile accounting';
  const available=mode==='paper'?s.paperBalance-t.spend+t.earned:marketBalance(state.runtime,market);
  if(!Number.isSafeInteger(available)||available-reserve<s.reserve)return 'Minimum wallet reserve';
  if(strategy.lastBuyAt&&now-Date.parse(strategy.lastBuyAt)<strategy.intervalMinutes*60000)return 'Waiting for next interval';
  if(!strategy.continuous&&strategy.stopOnWin&&rs.some(r=>r.confirmed&&r.amount>0&&own.some(o=>o.id===r.orderId)))return 'Stopped after a confirmed reward';
  if(strategy.kind==='odds'&&(!Number.isFinite(quote.odds)||quote.odds>strategy.maxOdds))return 'Probability threshold not met';
  if(profile==='guide'&&quote.parentOrderId)return 'The guide shares-only format supports first joins; cumulative additions require the documented or web format';
  if(levelBuying(strategy)){
    const level=nextTeamLevel(quote,strategy,orders);
    if(!level||level.threshold!==quote.teamLevel?.threshold||level.shares!==quote.shares||level.parentOrderId!==(quote.parentOrderId||null))return 'Team buying level changed; evaluate again';
    if(!Number.isFinite(quote.teamShares)||quote.teamShares<level.threshold)return 'Waiting for '+level.threshold+' joined team shares · buy '+level.shares+' additional share(s)';
    if(parent&&['payoutAddress','mergePayoutAddress'].some(k=>strategy[k]&&strategy[k]!==parent[k]))return 'Payout destination changed; use a new team for this strategy';
  }else{
    if(strategy.mode==='team'&&(!Number.isFinite(quote.teamShares)||quote.teamShares<strategy.minTeamShares))return 'Waiting for team share threshold';
    if(strategy.mode==='team'&&orders.some(o=>isFunded(o)&&o.packageId===quote.id))return 'Already joined this team';
  }
  return null;
}
export function normalizePackage(raw,now=new Date().toISOString(),team=false) {
  const p=raw.currencyAlgoTicket||raw;
  const market=p.currencyMarket||'BTC';
  const min=raw.minShareAmount??p.minShareAmount??p.price;
  const shares=raw.totalShares!==undefined?Number(raw.totalShares):raw.addedAmount!==undefined?Math.floor(providerUnits(raw.addedAmount,'catalogue team addedAmount')/providerUnits(min,'catalogue minimum share price')):null;
  const normalized={id:raw.id,name:p.name||'Unnamed package',coin:p.currencyAlgo?.currency||'?',
    mergeCoin:p.mergeCurrencyAlgo?.currency||null,withdrawRewards:p.withdrawRewards===true,
    market,price:providerUnits(team?min:p.price,'catalogue package price'),costBtc:MARKETS.includes(market)?providerUnits(team?min:p.price,'catalogue package price'):null,
    available:team?(['WAITING','COUNTDOWN'].includes(raw.status?.code||raw.status)&&raw.state!=='SOLD_OUT'):p.available===true,
    duration:(team?raw.duration:null)||p.duration||3600,odds:Number((team?raw.probabilityPrecision:null)||p.probabilityPrecision||p.probability)||null,
    team,teamState:team?(raw.state?.code||raw.state||null):null,buyUntil:team?(raw.lifeTimeTill||null):null,
    teamShares:shares,minShare:providerUnits(min,'catalogue minimum share price'),status:raw.status?.code||raw.status,
    teamCommitted:team&&raw.addedAmount!==undefined?providerUnits(raw.addedAmount,'catalogue team addedAmount'):null,
    blockRewards:catalogueBlockRewards(p),reward:p.currencyAlgo?.blockRewardWithNhFee??p.currencyAlgo?.blockReward??null,quotedAt:now};
  return MARKETS.includes(market)?fundingRecord(market,normalized):{...normalized,available:false};
}
export function pickQuote(packages,s,orders=[],profile='documented') {
  const choices=packages.filter(p=>p.team===(s.mode==='team')&&p.coin===s.coin&&paymentMarket(p)===paymentMarket(s)&&
    (s.packageId?p.id===s.packageId:(!s.packageName||p.name.toLowerCase()===s.packageName.toLowerCase())));
  if(levelBuying(s)){
    const eligible=choices.filter(p=>!rejectedTeamTarget(orders,p.id,profile)).flatMap(p=>{const l=nextTeamLevel(p,s,orders);return l&&!(profile==='guide'&&l.parentOrderId)?[fundingRecord(paymentMarket(p),{...p,teamLevel:{threshold:l.threshold,shares:l.shares},parentOrderId:l.parentOrderId,shares:l.shares,costBtc:money(p,'costBtc')*l.shares})]:[];});
    eligible.sort((a,b)=>Number(!!b.parentOrderId)-Number(!!a.parentOrderId));
    return eligible.find(p=>p.available&&p.teamShares>=p.teamLevel.threshold)||eligible.find(p=>p.available)||eligible[0]||null;
  }
  const eligible=choices.filter(p=>!p.team||(!rejectedTeamTarget(orders,p.id,profile)&&!orders.some(o=>isFunded(o)&&o.packageId===p.id)));
  const q=eligible.find(p=>p.available)||eligible[0];
  if(!q)return null;
  return fundingRecord(paymentMarket(q),{...q,costBtc:money(q,'costBtc')*(s.mode==='team'?s.shares:1)});
}
