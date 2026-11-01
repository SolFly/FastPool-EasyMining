import {isUnavailableTeam} from '../public/purchase-status.mjs';

export function confirmedRejection(error){
  return error?.code==='NICEHASH_API_ERROR'&&error.method==='POST'&&!error.uncertain&&[400,401,403,404,405,410,422,429].includes(error.upstreamStatus);
}
export function applyPurchaseFailure(order,error){
  order.status=error.uncertain?'UNKNOWN':'FAILED';order.error=error.message;
  order.submissionFailure={at:new Date().toISOString(),rejected:confirmedRejection(error),uncertain:!!error.uncertain,
    httpStatus:error.upstreamStatus||null,code:error.nicehashCode??null,method:error.method||null,path:error.path||null,requestId:error.requestId||order.requestId||null,providerMessage:error.providerMessage||null};
  if(order.submissionFailure.rejected){
    order.requestedCostBtc=order.costBtc;order.feeBtc=0;
    if(order.kind==='team'&&order.externalId===order.packageId){order.attemptedTeamId=order.externalId;order.externalId=null;}
    delete order.syncPending;
  }
  return {unavailableTeam:isUnavailableTeam(order)};
}

// Old versions persisted a provider rejection as text, then kept the attempted
// team ID as if it represented owned membership. Accept only our exact error
// format, a terminal failed intent and a matching target; never infer a refund.
export function legacyTeamRejection(order){
  if(order.kind!=='team'||!['FAILED','REJECTED'].includes(order.status)||!order.requestId||order.accountingOverride||!order.externalId||order.externalId!==order.packageId)return null;
  if(order.submissionFailure?.rejected)return order.submissionFailure;
  const m=/^NiceHash rejected POST (\/(?:main|hashpower)\/api\/v2\/hashpower\/shared\/ticket\/([a-f0-9-]{36})) \(HTTP (400|401|403|404|405|410|422|429), code ([A-Za-z0-9_-]+)\)(?:\.|$)/i.exec(order.error||'');
  if(!m||m[2].toLowerCase()!==order.packageId.toLowerCase())return null;
  return {at:order.createdAt,rejected:true,uncertain:false,httpStatus:Number(m[3]),code:m[4],method:'POST',path:m[1],requestId:order.requestId,legacy:true};
}
