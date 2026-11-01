import {providerUnits,providerNetReward} from './provider-amounts.mjs';
import {moneyValue} from './money.mjs';

const valid=n=>Number.isSafeInteger(n)&&n>=0;
function optionalAmount(value){
  if(value===null||value===undefined)return null;
  try{return providerUnits(value,'team estimate amount');}catch{return null;}
}
export function catalogueBlockRewards(template){
  return [template?.currencyAlgo,template?.mergeCurrencyAlgo].filter(Boolean).flatMap(a=>{
    try{
      // NiceHash's package UI uses blockRewardWithNhFee for its displayed
      // per-block reference. Real earnings come from member reward records.
      const amount=providerNetReward(a.blockRewardWithNhFee??a.blockReward,0,'block reward estimate').amount;
      return /^[A-Z0-9]{2,12}$/.test(a.currency||'')?[{coin:a.currency,amount}]:[];
    }catch{return [];}
  });
}
function shareCount(amount,min){return valid(amount)&&valid(min)&&min>0&&amount%min===0?amount/min:null;}
function estimate(blocks,{team=false,memberAmount=null,totalAmount=null,memberShares=null,totalShares=null,source,at=new Date().toISOString()}){
  const hasAmounts=valid(memberAmount)&&memberAmount>0&&valid(totalAmount)&&totalAmount>=memberAmount;
  const hasShares=valid(memberShares)&&memberShares>0&&valid(totalShares)&&totalShares>=memberShares;
  const numerator=team?(hasAmounts?memberAmount:hasShares?memberShares:null):1;
  const denominator=team?(hasAmounts?totalAmount:hasShares?totalShares:null):1;
  const known=numerator!==null&&denominator!==null;
  return {scope:team?'team-member':'solo',source,at,memberAmount,totalAmount,memberShares,totalShares,
    fraction:known?numerator/denominator:null,
    blocks:(blocks||[]).filter(b=>b&&valid(b.amount)).map(b=>({coin:b.coin,fullAmount:b.amount,
      amount:known?Number(BigInt(b.amount)*BigInt(numerator)/BigInt(denominator)):null})),
    note:team&&!known?'Team contribution totals are unavailable. No personal block reward is assumed.':null};
}

// A catalogue contains existing commitments. A new purchase adds its own shares
// exactly once, then freezes the denominator for a paper purchase's settlement.
export function purchaseRewardEstimate(pkg,shares=1,at){
  const blocks=pkg.blockRewards||(!pkg.mergeCoin&&pkg.reward!==undefined?[{coin:pkg.coin,amount:optionalAmount(pkg.reward)}]:[]);
  const price=moneyValue(pkg,'costBtc');
  const memberAmount=valid(price)&&valid(shares)?price*shares:null;
  const existingAmount=valid(pkg.teamCommitted)?pkg.teamCommitted:valid(pkg.teamShares)&&valid(pkg.minShare)?pkg.teamShares*pkg.minShare:null;
  const totalAmount=valid(existingAmount)&&valid(memberAmount)?existingAmount+memberAmount:null;
  return estimate(blocks,{team:!!pkg.team,memberAmount,totalAmount,memberShares:shares,
    totalShares:valid(pkg.teamShares)&&valid(shares)?pkg.teamShares+shares:null,source:'purchase snapshot',at});
}

// Private team totals already include the member's commitment. Never add it again.
// Optional estimate metadata cannot invalidate a verified financial payout.
export function accountTeamEstimate(raw,member,at){
  const template=raw.currencyAlgoTicket||{},memberAmount=optionalAmount(member.addedAmount),totalAmount=optionalAmount(raw.addedAmount);
  const min=optionalAmount(raw.minShareAmount??template.minShareAmount??(template.currencyMarket!=='USDT'?'0.0001':null));
  const memberShares=shareCount(memberAmount,min)??(valid(member.shares?.small)&&member.shares.small>0?member.shares.small:null);
  const totalShares=shareCount(totalAmount,min)??(valid(raw.totalShares)&&raw.totalShares>0?raw.totalShares:null);
  return estimate(catalogueBlockRewards(template),{team:true,memberAmount,totalAmount,memberShares,totalShares,source:'verified account member',at});
}

// Missing historical allocation is unknown, never a fallback to 100% ownership.
export function personalBlockRewards(order){
  const e=order.rewardEstimate;
  if(!e||e.scope!==(order.kind==='team'?'team-member':'solo'))return [];
  return e.blocks.filter(b=>valid(b.amount));
}
