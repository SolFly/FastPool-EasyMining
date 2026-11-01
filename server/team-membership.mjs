const identity=value=>String(value?.id||value||'').trim().toLowerCase();
export function teamMembership(raw,orgId){
  const org=identity(orgId),source=raw?.members;
  const members=Array.isArray(source)?source.filter(Boolean):Object.entries(source||{}).filter(([,v])=>v&&typeof v==='object').map(([id,v])=>({...v,organizationId:v.organizationId||id}));
  const member=members.find(m=>org&&identity(m.organizationId||m.organization?.id)===org);
  if(member)return {state:'owned',member};
  const personalSpend=Number(raw?.myAddedAmount||0)>0;
  const redactedSpend=members.some(m=>Number(m.addedAmount||0)>0&&!identity(m.organizationId||m.organization?.id));
  if(personalSpend||redactedSpend)return {state:'unattributed',member:null};
  // NiceHash uses this endpoint for the signed-in package catalogue too.
  // Missing/empty members means no joined participation, not an unreadable purchase.
  return {state:members.length?'unrelated':'unjoined',member:null};
}
