import {paymentMarket} from './money.mjs';
import {SAT,isAccounted,isRewardAccounted} from './core.mjs';
export const REWARD_COINS=['BTC','BCH','LTC','DOGE','ZEC'];
export function normalizeRates(raw,at=new Date().toISOString()) {
  if(!Array.isArray(raw?.list))throw new Error('Unexpected exchange-rate response');
  const pairs=new Map();
  for(const r of raw.list){const n=Number(r.exchangeRate);if(Number.isFinite(n)&&n>0)pairs.set(r.fromCurrency+'/'+r.toCurrency,n);}
  const direct=(from,to)=>from===to?1:pairs.get(from+'/'+to)||(pairs.has(to+'/'+from)?1/pairs.get(to+'/'+from):null);
  const route=(from,to,depth,seen)=>{const known=direct(from,to);if(known)return known;if(!depth)return null;for(const via of ['USD','BTC','USDT','EUR']){if(seen.has(via))continue;const first=direct(from,via);if(!first)continue;const tail=route(via,to,depth-1,new Set([...seen,via])),value=tail?first*tail:null;if(Number.isFinite(value)&&value>0)return value;}return null;};
  const rate=(from,to)=>route(from,to,2,new Set([from]));
  const coins=[...new Set([...REWARD_COINS,'USDT',...raw.list.map(r=>r.fromCurrency)])],fiat={USD:{},EUR:{}},btc={BTC:1};
  for(const c of coins){for(const f of ['USD','EUR']){const n=rate(c,f);if(n)fiat[f][c]=n;}const n=rate(c,'BTC');if(n)btc[c]=n;}
  return {at,source:'NiceHash exchangeRate/list',fiat,btc};
}
export function fiatValue(amount,coin,currency,rates) {
  const rate=rates?.fiat?.[currency]?.[coin];
  return Number.isSafeInteger(amount)&&Number.isFinite(rate)&&rate>0?amount/SAT*rate:null;
}
export function rewardSummary(orders,rewards,{mode='paper',from=0,to=Infinity,market='BTC'}={},rates) {
  const ids=new Set(orders.filter(o=>isAccounted(o)&&o.mode===mode&&paymentMarket(o)===market).map(o=>o.id));
  const selected=rewards.filter(r=>isRewardAccounted(r)&&ids.has(r.orderId)&&Date.parse(r.confirmedAt||r.createdAt)>=from&&Date.parse(r.confirmedAt||r.createdAt)<=to);
  const coins=[...new Set([...REWARD_COINS,...selected.map(r=>r.coin)])];
  return coins.map(coin=>{
    const rs=selected.filter(r=>r.coin===coin),confirmed=rs.filter(r=>r.confirmed).reduce((n,r)=>n+r.amount,0),pending=rs.filter(r=>!r.confirmed).reduce((n,r)=>n+r.amount,0);
    return {coin,confirmed,pending,usd:fiatValue(confirmed,coin,'USD',rates),eur:fiatValue(confirmed,coin,'EUR',rates),count:rs.length};
  });
}
export const ratesStale=(rates,now=Date.now())=>!rates?.at||!Number.isFinite(Date.parse(rates.at))||now-Date.parse(rates.at)>15*60000;
