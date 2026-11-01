import {totals} from './core.mjs';
import {paymentMarket} from './money.mjs';

function targetProgress(used,target){
  const percent=Number.isSafeInteger(target)&&target>0?used/target*100:null;
  return {used,target,percent,width:percent===null?0:Math.max(0,Math.min(100,percent))};
}

// Progress is lifetime activity for one strategy, execution mode and funding
// currency. Continuous buying changes enforcement, never hides the saved targets.
export function strategyProgress(strategy,orders,mode){
  const market=paymentMarket(strategy);
  const {spend,count}=totals(orders,[],{mode,strategyId:strategy.id,market});
  return {market,budget:targetProgress(spend,strategy.budget),purchases:targetProgress(count,strategy.maxPurchases)};
}
