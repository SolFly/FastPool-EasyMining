import {providerUnits} from '../public/provider-amounts.mjs';
const id=value=>typeof value==='string'?value.trim():typeof value?.id==='string'?value.id.trim():'';
export function accountTeamReference(raw){
  // Current account history embeds the full team as sharedTicket. It is not
  // the sharedTicketId marker used by some accounting responses.
  if(raw.sharedTicket!=null&&raw.sharedTicket!==false){
    const embedded=id(raw.sharedTicket);
    if(!embedded)throw new Error('Team account entry has an invalid sharedTicket object');
    if(id(raw.sharedTicketId)&&id(raw.sharedTicketId)!==embedded)throw new Error('Conflicting team IDs in account entry');
    return {teamId:embedded,orderId:id(raw.id),explicit:true,embedded:typeof raw.sharedTicket==='object'?raw.sharedTicket:null};
  }
  const explicit=id(raw.sharedTicketId);
  if(explicit)return {teamId:explicit,orderId:id(raw.id),explicit:true};
  // NiceHash also marks team summaries with myAddedAmount. Resolve their ID
  // through the team detail endpoint and verify membership before importing.
  if(raw.sharedTicketId!=null)throw new Error('Team account entry has an invalid sharedTicketId');
  if(raw.myAddedAmount!=null&&providerUnits(raw.myAddedAmount,'account team myAddedAmount')>0){
    const teamId=id(raw.id);if(!teamId)throw new Error('Team account entry has no provider ID');
    return {teamId,orderId:teamId,explicit:false};
  }
  const rewards=providerRewardRows(raw.soloReward),shared=rewards.filter(r=>r.shared===true);
  if(shared.length){
    const refs=[...new Set(shared.map(r=>id(r.packageId)).filter(Boolean))];
    if(refs.length>1)throw new Error('Shared rewards reference several team packages; attribution requires review');
    return {teamId:refs[0]||null,orderId:id(raw.id),explicit:true,rewardReference:true};
  }
  return null;
}
export function providerRewardRows(rewards,depth=0){
  if(!Array.isArray(rewards)||depth>8)return [];
  return rewards.flatMap(r=>r&&typeof r==='object'?[r,...providerRewardRows(r.groupedRewards,depth+1)]:[]);
}
export function personalSoloProof(raw,organizationId){
  const org=String(organizationId||'').toLowerCase(),owner=String(raw.organizationId||'').toLowerCase();
  if(owner&&owner!==org)return null;
  if(owner&&owner===org)return 'own organization on private order';
  if(Object.hasOwn(raw,'sharedTicket')&&(raw.sharedTicket===null||raw.sharedTicket===false))return 'private order explicitly has no shared ticket';
  const rewards=providerRewardRows(raw.soloReward);
  if(rewards.length&&rewards.every(r=>r.shared===false))return 'provider marks every reward as personal solo';
  return null;
}
export const automaticImport=o=>o.source==='NiceHash import'&&!o.requestId&&!o.strategyId&&!o.accountingOverride;
export const manuallyEditedReward=r=>!!r.manualConfirmed||String(r.valuation||'').startsWith('Manual valuation:');
