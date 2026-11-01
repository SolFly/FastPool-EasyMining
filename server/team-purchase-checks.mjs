import {guard} from '../public/core.mjs';
import {confirmedRejection} from './purchase-failures.mjs';

const changed=message=>Object.assign(new Error(message),{code:'TEAM_QUOTE_CHANGED',status:409});
export function teamSnapshot(q){
  if(!q)return null;
  return {id:q.id,name:q.name,coin:q.coin,mergeCoin:q.mergeCoin||null,market:q.market,
    status:q.status||null,state:q.teamState||null,available:q.available===true,
    quotedAt:q.quotedAt||null,buyUntil:q.buyUntil||null,sharePriceBtc:q.minShare??q.price??null,
    joinedShares:q.teamShares??null};
}
export function purchaseCheck(engine,quote,strategy,{manual=false}={}){
  return {checkedAt:new Date().toISOString(),clockOffsetMs:Math.round(engine.client().offset||0),
    selection:manual?'manual':quote.teamLevel?'levels':'strategy',fixedTeam:!!strategy.packageId,
    shares:quote.shares??strategy.shares,additionalCostBtc:quote.costBtc,
    level:quote.teamLevel?{threshold:quote.teamLevel.threshold,shares:quote.teamLevel.shares}:null,
    before:teamSnapshot(quote)};
}
export function validateTeamForPurchase(engine,quote,strategy,{manual=false}={}){
  // Restore the v1.2.4 dependency boundary: its verified catalogue and original
  // guards authorize the join. No extra network read or inferred deadline may
  // veto it. Recheck local caps/arming/pause after resolving the destination.
  const reason=guard(engine.store.state(),strategy,quote,Date.now(),{manual});
  if(reason)throw changed(reason);
  return quote;
}
export async function inspectTeamRejection(engine,order,error,{check=order.purchaseCheck,failure=order.submissionFailure}={}){
  if(order.kind!=='team'||!confirmedRejection(error)||![404,410].includes(error.upstreamStatus))return;
  const evidence={...(check||{}),after:{checkedAt:new Date().toISOString()}};
  try{
    // Read only. A 404 never triggers another provider POST or a route fallback.
    const packages=await engine.client().packages(),q=packages.find(p=>p.id===order.packageId&&p.team);
    evidence.after={checkedAt:new Date().toISOString(),listed:!!q,team:teamSnapshot(q)};
    evidence.finding=!q?'not-listed-after-rejection':!q.available?'closed-after-rejection':'still-listed-after-rejection';
  }catch(readError){
    evidence.finding='verification-read-failed';
    evidence.after.httpStatus=readError.upstreamStatus||null;
  }
  if(failure)failure.teamCheck=evidence;
  error.teamCheck=evidence;
  if(!error.requestId)error.requestId=failure?.requestId||order.requestId;
}
