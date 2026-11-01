import {STRATEGY_DEFAULTS,payoutFields} from './core.mjs';
import {purchaseRewardEstimate} from './package-rewards.mjs';
const conflict=message=>Object.assign(new Error(message),{status:409});
function reviewId(){
  if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
  const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
export function manualQuote(packages,input,settings,{orgId=null,now=Date.now()}={}) {
  const p=packages.find(p=>p.id===input.packageId);
  if(!p||!p.available)throw conflict('Package is no longer available. Refresh the catalogue.');
  if(p.market!=='BTC')throw new Error('Only BTC-priced packages can be bought in this version');
  const shares=input.shares??1;
  if(!Number.isInteger(shares)||shares<1||shares>100||(!p.team&&shares!==1))throw new Error('Choose 1–100 team shares, or one solo package');
  const payout=payoutFields(input);
  if(payout.mergePayoutAddress&&!p.mergeCoin)throw new Error('This package has no merged reward coin');
  if(p.withdrawRewards&&(!payout.payoutAddress||(p.mergeCoin&&!payout.mergePayoutAddress)))throw new Error('Choose a payout address for each reward coin');
  const costBtc=p.costBtc*shares;
  if(!Number.isSafeInteger(costBtc)||costBtc<=0)throw new Error('Package price is invalid');
  return {id:reviewId(),mode:settings.mode,orgId,packageId:p.id,name:p.name,coin:p.coin,mergeCoin:p.mergeCoin||null,
    team:p.team,shares,costBtc,reservedBtc:costBtc+Math.ceil(costBtc*settings.feeBufferBps/10000),...payout,
    rewardEstimate:purchaseRewardEstimate(p,shares,new Date(now).toISOString()),
    createdAt:new Date(now).toISOString(),expiresAt:new Date(now+120000).toISOString()};
}
export const manualStrategy=q=>({...STRATEGY_DEFAULTS,id:'manual:'+q.id,enabled:true,stopOnWin:false,minTeamShares:0,
  mode:q.team?'team':'solo',coin:q.coin,shares:q.shares,maxPrice:q.costBtc,budget:q.reservedBtc,
  maxPurchases:1,...payoutFields(q)});
