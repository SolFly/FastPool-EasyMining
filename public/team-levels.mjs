export const levelBuying=s=>s.mode==='team'&&Array.isArray(s.teamLevels)&&s.teamLevels.length>0;
export function validateTeamLevels(value){
  if(!Array.isArray(value)||value.length>20)throw new Error('Choose up to 20 team buying levels');
  let previous=-1;
  return value.map(row=>{
    if(!row||typeof row!=='object'||!Number.isInteger(row.threshold)||row.threshold<0||row.threshold>100000||row.threshold<=previous)throw new Error('Team level thresholds must be increasing whole numbers from 0 to 100000');
    if(!Number.isInteger(row.shares)||row.shares<1||row.shares>100)throw new Error('Buy 1–100 additional shares at each level');
    previous=row.threshold;return {threshold:row.threshold,shares:row.shares};
  });
}
const funded=o=>!o.supersededBy&&!['FAILED','REJECTED','SUPERSEDED'].includes(o.status);
export const fundedLevel=b=>!['FAILED','REJECTED'].includes(b.status);
export function purchaseCount(order,from=-Infinity,to=Infinity){
  const rows=order.teamBuys?.length?order.teamBuys:[{status:order.status,createdAt:order.createdAt}];
  return rows.filter(b=>fundedLevel(b)&&((from===-Infinity&&to===Infinity)||(Date.parse(b.createdAt)>=from&&Date.parse(b.createdAt)<=to))).length;
}
export function nextTeamLevel(pkg,strategy,orders){
  if(!levelBuying(strategy))return null;
  const owned=orders.find(o=>funded(o)&&o.kind==='team'&&o.packageId===pkg.id);
  if(owned&&(owned.strategyId!==strategy.id||!['ACTIVE','PENDING'].includes(owned.status)||owned.accountingOverride||owned.pendingTeamPurchase||owned.syncPending))return null;
  const used=new Set((owned?.teamBuys||[]).filter(fundedLevel).map(b=>b.threshold));
  // An earlier entry by this same strategy counts as the first level when the
  // user enables levels. Never adopt manual entries or another strategy's team.
  if(owned&&!owned.teamBuys?.length)used.add(strategy.teamLevels[0].threshold);
  const next=strategy.teamLevels.find(l=>!used.has(l.threshold));
  return next?{...next,parentOrderId:owned?.id||null}:null;
}
