import {randomUUID} from 'node:crypto';
import {guard,spendEntries} from '../public/core.mjs';
import {purchaseRewardEstimate} from '../public/package-rewards.mjs';
import {applyPurchaseFailure,confirmedRejection} from './purchase-failures.mjs';
import {validateTeamForPurchase,purchaseCheck,inspectTeamRejection} from './team-purchase-checks.mjs';

function total(order,cost,fee,when,note){
  const before=order.costBtc+(order.feeBtc||0)-(order.refundBtc||0),history=spendEntries(order);
  order.costBtc=cost;order.feeBtc=fee;
  const change=cost+fee-(order.refundBtc||0)-before;
  if(change)order.spendHistory=[...history,{at:when,amountBtc:change,note}];
}
export function levelRewardEstimate(pkg,before,shares,live){
  const existingShares=before?.shares||0,existingCost=before?.costBtc||0;
  const base=live&&before?{...pkg,teamShares:Number.isSafeInteger(pkg.teamShares)?pkg.teamShares-existingShares:null,
    teamCommitted:Number.isSafeInteger(pkg.teamCommitted)?pkg.teamCommitted-existingCost:null}:pkg;
  return purchaseRewardEstimate(base,existingShares+shares);
}
export function resolveUnboughtLevel(order,note,when=new Date().toISOString()){
  const pending=order.pendingTeamPurchase,entry=order.teamBuys?.find(b=>b.requestId===pending?.requestId);
  if(!pending||!entry)throw new Error('No pending team level to reconcile');
  const before=pending.before;
  if(before){
    for(const key of ['costBtc','feeBtc','shares','status','spendHistory','rewardEstimate']){
      if(Object.hasOwn(before,key))order[key]=structuredClone(before[key]);else delete order[key];
    }
  }else{order.status='FAILED';order.feeBtc=0;order.attemptedTeamId=order.externalId;order.externalId=null;}
  entry.status='REJECTED';entry.manualNoPurchase={at:when,note};order.resolution=note;
  delete order.pendingTeamPurchase;delete order.error;delete order.syncPending;
}
export async function executeTeamLevel(engine,strategy,quote,owner,{onSkip=()=>{}}={}){
  const store=engine.store,settings=store.get('settings'),live=settings.mode==='live';
  const skip=reason=>{onSkip(reason);store.event('info','Team level skipped before submission: '+reason);return false;};
  const before=quote.parentOrderId?structuredClone(store.orders().find(o=>o.id===quote.parentOrderId)):null;
  let pkg=store.get('packages').find(p=>p.id===quote.id),destination,teamUpdate;
  const buying={...strategy,shares:quote.shares};
  if(live){
    destination=await engine.client().payoutDestination(quote,buying);
    if(destination.requiresTwofa)throw new Error('Team buying levels require a payout address saved in NiceHash, or the existing default');
    try{quote=validateTeamForPurchase(engine,quote,buying);}
    catch(error){if(error.code!=='TEAM_QUOTE_CHANGED')throw error;return skip(error.message);}
    // A first join is the original v1.2.4 purchase. A private detail endpoint
    // may not expose an unjoined ticket; only an addition needs that baseline.
    if(before){
      let prepared;
      try{prepared=await engine.client().prepareTeamLevel(quote,buying,before);}
      catch(error){if(error.code!=='TEAM_QUOTE_CHANGED')throw error;return skip(error.message);}
      pkg=prepared.package;teamUpdate=prepared.update;
      quote={...quote,...pkg,costBtc:pkg.costBtc*quote.shares};
    }
  }
  const reason=guard(store.state(),strategy,quote);
  if(reason)return skip(reason);
  if(store.get('settings').mode!==settings.mode)return skip('Execution mode changed before submitting the team level');
  if(!store.owns(owner))throw new Error('Purchase lock expired before submitting the team level');
  const when=new Date().toISOString(),previousBuyAt=strategy.lastBuyAt;
  const entry={threshold:quote.teamLevel.threshold,shares:quote.shares,amountBtc:quote.costBtc,requestId:randomUUID(),createdAt:when,status:'SUBMITTING'};
  let order=before?structuredClone(before):{id:randomUUID(),requestId:entry.requestId,mode:settings.mode,kind:'team',strategyId:strategy.id,
    externalId:live?quote.id:null,packageId:quote.id,name:quote.name,coin:quote.coin,mergeCoin:quote.mergeCoin,
    payoutAddress:strategy.payoutAddress||'',mergePayoutAddress:strategy.mergePayoutAddress||'',shares:0,costBtc:0,feeBtc:0,refundBtc:0,
    createdAt:when,endAt:new Date(Date.now()+quote.duration*1000).toISOString(),odds:quote.odds,reward:quote.reward,source:live?'Strategy engine':'Paper simulation'};
  const check=live?purchaseCheck(engine,quote,buying):null;if(check)order.purchaseCheck=check;
  if(before&&!order.teamBuys?.length)order.teamBuys=[{threshold:strategy.teamLevels[0].threshold,shares:before.shares,amountBtc:before.costBtc,requestId:before.requestId||null,createdAt:before.createdAt,status:'CONFIRMED',existingEntry:true}];
  order.teamBuys=[...(order.teamBuys||[]),entry];
  order.pendingTeamPurchase={requestId:entry.requestId,targetCostBtc:(before?.costBtc||0)+quote.costBtc,targetShares:(before?.shares||0)+quote.shares,
    before:before?Object.fromEntries(['costBtc','feeBtc','shares','status','spendHistory','rewardEstimate'].filter(key=>Object.hasOwn(before,key)).map(key=>[key,before[key]])):null};
  total(order,order.pendingTeamPurchase.targetCostBtc,(before?.feeBtc||0)+Math.ceil(quote.costBtc*settings.feeBufferBps/10000),when,'Team buying level '+entry.threshold+' reserved');
  order.shares=order.pendingTeamPurchase.targetShares;order.status='SUBMITTING';order.rewardEstimate=levelRewardEstimate(pkg,before,quote.shares,live);
  store.saveOrder(order);strategy.lastBuyAt=when;store.strategy(strategy);
  try{
    if(live){
      const result=await engine.client().buy(quote,buying,entry.requestId,{destination,teamUpdate});
      if(result.id!==quote.id||result.costBtc!==quote.costBtc)throw Object.assign(new Error('Team level response needs verification'),{uncertain:true});
      const runtime=store.get('runtime')||{};store.set('runtime',{...runtime,balance:Math.max(0,runtime.balance-quote.costBtc)});
    }
    entry.status=live?'PENDING':'CONFIRMED';order.status=live?'PENDING':'ACTIVE';
    total(order,order.pendingTeamPurchase.targetCostBtc,0,when,'Team level accepted; fee buffer released');
    if(!live)delete order.pendingTeamPurchase;
    store.saveOrder(order);store.event('info',(live?'Live':'Paper')+' team level '+entry.threshold+': +'+entry.shares+' share(s) · '+order.name);
    return false;
  }catch(error){
    entry.status=confirmedRejection(error)?'FAILED':'UNKNOWN';entry.error=error.message;
    if(confirmedRejection(error)){
      const failed={...order};applyPurchaseFailure(failed,error);entry.failure=failed.submissionFailure;
      if(before)order={...before,teamBuys:order.teamBuys,lastTeamPurchaseFailure:entry.failure};
      else{order=failed;delete order.pendingTeamPurchase;}
      strategy.lastBuyAt=previousBuyAt;store.strategy(strategy);
    }else{order.status='UNKNOWN';order.error=error.message;}
    store.saveOrder(order);
    await inspectTeamRejection(engine,order,error,{check,failure:entry.failure});store.saveOrder(order);
    if(!entry.failure||![404,410].includes(entry.failure.httpStatus))engine.pause(error.message);
    engine.recordError(error);return true;
  }
}
