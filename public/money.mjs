export const MARKETS=['BTC','USDT'];
export const USDT_LIMITS=Object.freeze({dailyCap:0,weeklyCap:0,monthlyCap:0,maxOrder:0,reserve:0,stopLoss:0,takeProfit:0,paperBalance:10000000000});
const keys={costBtc:'costAmount',feeBtc:'feeAmount',refundBtc:'refundAmount',amountBtc:'amount',reservedBtc:'reservedAmount',targetCostBtc:'targetAmount',beforeCostBtc:'beforeAmount',requestedCostBtc:'requestedAmount'};
export const paymentMarket=v=>v?.currencyMarket||v?.currencyAlgoTicket?.currencyMarket||(MARKETS.includes(v?.market)?v.market:'BTC');
export const moneyValue=(v,key)=>v?.[paymentMarket(v)==='USDT'?keys[key]:key];
export const money=(v,key)=>moneyValue(v,key)??0;
export function fundingRecord(market,value){
 const out={...value,market};
 if(market==='USDT')for(const [old,next] of Object.entries(keys))if(Object.hasOwn(out,old)){out[next]=out[old];delete out[old];}
 return out;
}
export const marketLimits=(settings,market)=>market==='USDT'?{...settings,...USDT_LIMITS,...settings.usdtLimits}:settings;
export const marketBalance=(runtime,market)=>market==='BTC'?(runtime?.balance??runtime?.balances?.BTC):runtime?.balances?.USDT;
export const rewardMarketValue=(reward,market)=>market==='USDT'?reward?.valueUsdt:reward?.valueBtc;
export function orderView(order){
 const out={...order};
 if(paymentMarket(order)==='USDT'){
  for(const [old,next] of Object.entries(keys))if(Object.hasOwn(order,next))out[old]=order[next];
  out.spendHistory=order.spendHistory?.map(e=>({...e,amountBtc:money(e,'amountBtc')}));
  out.teamBuys=order.teamBuys?.map(e=>({...e,amountBtc:money(e,'amountBtc')}));
 }
 return out;
}
export function ledgerProjection(orders,rewards,market='BTC'){
 const selected=orders.filter(o=>paymentMarket(o)===market).map(orderView),ids=new Set(selected.map(o=>o.id));
 return {orders:selected,rewards:rewards.filter(r=>ids.has(r.orderId)).map(r=>market==='USDT'?{...r,valueBtc:r.valueUsdt,valuation:r.usdtValuation}:r)};
}
