import {teamPurchasePath} from './request-profiles.mjs';
// Documented REST paths, also used by the user-confirmed working v1.2.4.
// These remain the default; alternate formats require an explicit settings change.
export const TEAM_PURCHASE_PATH='/main/api/v2/hashpower/shared/ticket/';
export const SOLO_PURCHASE_PATH='/main/api/v2/hashpower/solo/order';
export const isRejectedAttempt=o=>o.submissionFailure?.rejected===true;
const teamTarget=path=>typeof path==='string'?path.match(/^\/(?:main|hashpower)\/api\/v2\/hashpower\/shared\/ticket\/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i)?.[1]:undefined;
export const isTeamStateRejection=f=>f?.rejected===true&&f.uncertain!==true&&f.method==='POST'&&Number(f.httpStatus)===400&&String(f.code)==='5251'&&!!teamTarget(f.path);
export const TEAM_STATE_REJECTED_REASON="NiceHash rejected the current team's state (code 5251); waiting for a different matching team";
export const isUnavailableTeam=o=>o.kind==='team'&&isRejectedAttempt(o)&&([404,410].includes(o.submissionFailure.httpStatus)||isTeamStateRejection(o.submissionFailure));
// Route/format-specific 404/410 exclusions keep their previous scope. Uncertain
// purchases remain protected by the global reconciliation guard on every path.
export function rejectedTeamReason(orders,id,profile='documented'){
 let reason='';
 for(const o of orders){
  if(o.packageId!==id||o.kind!=='team')continue;
  for(const f of [o.lastTeamPurchaseFailure,o.submissionFailure,...(o.teamBuys||[]).map(e=>e.failure)]){
   if(isTeamStateRejection(f)&&teamTarget(f.path)===id)return TEAM_STATE_REJECTED_REASON;
   if(f?.rejected&&[404,410].includes(f.httpStatus)&&f.path===teamPurchasePath(profile)+id&&(!f.purchaseRequestProfile||f.purchaseRequestProfile===profile))reason='NiceHash rejected the current team (HTTP 404/410); waiting for a different matching team';
  }
 }
 return reason;
}
// A 5251 rejection is specific to the team's state and remains excluded across
// formats. Changing formats never retries that team or an uncertain purchase.
export const rejectedTeamTarget=(orders,id,profile='documented')=>!!rejectedTeamReason(orders,id,profile);
