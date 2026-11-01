import {randomUUID} from 'node:crypto';
import {guard,payoutFields} from '../public/core.mjs';
import {manualQuote,manualStrategy} from '../public/purchases.mjs';
import {normalizeStatus} from './nicehash.mjs';
import {purchaseRewardEstimate} from '../public/package-rewards.mjs';
import {applyPurchaseFailure} from './purchase-failures.mjs';
import {validateTeamForPurchase,purchaseCheck,inspectTeamRejection} from './team-purchase-checks.mjs';
export {manualQuote,manualStrategy} from '../public/purchases.mjs';

const conflict=message=>Object.assign(new Error(message),{status:409});
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export class ManualPurchases {
  constructor(engine){this.engine=engine;this.store=engine.store;}
  async exclusive(fn){
    const engine=this.engine,owner=randomUUID();
    if(engine.busy||!this.store.acquire(owner))throw conflict('A purchase or sync is in progress. Wait for it to finish.');
    engine.busy=true;const heartbeat=setInterval(()=>this.store.renew(owner),20000);
    try{return await fn(owner);}catch(e){if(e.code==='NICEHASH_API_ERROR')engine.recordError(e);throw e;}
    finally{clearInterval(heartbeat);engine.busy=false;this.store.release(owner);}
  }
  async quote(input){return this.exclusive(async()=>{
    await this.engine.refreshPackages();
    const quote=manualQuote(this.store.get('packages'),input,this.store.get('settings'),{orgId:this.engine.credentials()?.orgId||null});
    if(quote.mode==='live')quote.requiresTwofa=(await this.engine.client().payoutDestination(quote,quote)).requiresTwofa;
    this.store.set('purchase-quote:'+quote.id,quote);
    // Unsubmitted quotes have no spending authority after expiry.
    this.store.db.prepare("DELETE FROM kv WHERE key LIKE 'purchase-quote:%' AND json_extract(value,'$.orderId') IS NULL AND json_extract(value,'$.expiresAt') < ?").run(new Date().toISOString());
    return quote;
  });}
  async buy(quoteId,{twofaToken=''}={}){
    if(!uuid.test(quoteId||''))throw new Error('Invalid purchase review ID');
    return this.exclusive(async owner=>{
      const key='purchase-quote:'+quoteId,review=this.store.get(key);
      if(!review)throw conflict('Purchase review was not found. Review the package again.');
      // Every review is single-use, including failed and uncertain submissions.
      if(review.orderId){const order=this.store.orders().find(o=>o.id===review.orderId);if(!order)throw conflict('Purchase needs administrator reconciliation');return {order,replayed:true};}
      if(Date.now()>Date.parse(review.expiresAt))throw conflict('Purchase review expired. Review the latest price again.');
      let settings=this.store.get('settings');
      if(settings.mode!==review.mode||(this.engine.credentials()?.orgId||null)!==review.orgId)throw conflict('Mode or account changed. Review the purchase again.');
      if(settings.mode==='live'){
        if(!settings.liveArmed)throw conflict('Arm live buying in Settings before submitting a real purchase. The strategy engine can stay paused.');
        await this.engine.sync();
      }
      await this.engine.refreshPackages();
      if(Date.now()>Date.parse(review.expiresAt))throw conflict('Purchase review expired during sync. Review the package again.');
      let p=(this.store.get('packages')||[]).find(p=>p.id===review.packageId);
      if(!p||p.coin!==review.coin||(p.mergeCoin||null)!==review.mergeCoin)throw conflict('Package changed. Review the purchase again.');
      let quote={...p,costBtc:p.costBtc*review.shares};const strategy=manualStrategy(review);
      const state=this.store.state(),reason=guard(state,strategy,quote,Date.now(),{manual:true});
      if(reason)throw conflict(reason);
      let destination;
      if(state.settings.mode==='live'){
        destination=await this.engine.client().payoutDestination(quote,review);
        if(destination.requiresTwofa&&!/^\d{6,8}$/.test(twofaToken))throw new Error('Enter the current NiceHash 2FA code for this unsaved payout address, or choose an address saved in NiceHash.');
        if(quote.team)quote=validateTeamForPurchase(this.engine,quote,strategy,{manual:true});
      }
      const latest=this.store.state(),latestReason=guard(latest,strategy,quote,Date.now(),{manual:true});
      if(latestReason)throw conflict(latestReason);
      if(latest.settings.mode!==review.mode||(this.engine.credentials()?.orgId||null)!==review.orgId)throw conflict('Mode or account changed. Review the purchase again.');
      if(Date.now()>Date.parse(review.expiresAt))throw conflict('Purchase review expired. Review the package again.');
      if(!this.store.owns(owner))throw conflict('Purchase lock expired. Review the account before retrying.');
      settings=latest.settings;
      const order={id:randomUUID(),requestId:review.id,mode:settings.mode,kind:strategy.mode,strategyId:null,
        packageId:quote.id,name:quote.name,coin:quote.coin,mergeCoin:quote.mergeCoin,shares:review.shares,
        ...payoutFields(review),costBtc:quote.costBtc,feeBtc:Math.ceil(quote.costBtc*settings.feeBufferBps/10000),refundBtc:0,
        createdAt:new Date().toISOString(),status:'SUBMITTING',odds:quote.odds,reward:quote.reward,
        rewardEstimate:purchaseRewardEstimate(p,review.shares),
        endAt:new Date(Date.now()+quote.duration*1000).toISOString(),source:settings.mode==='paper'?'Manual paper purchase':'Manual web purchase',
        externalId:settings.mode==='live'&&quote.team?quote.id:null};
      if(settings.mode==='live'&&quote.team)order.purchaseCheck=purchaseCheck(this.engine,quote,strategy,{manual:true});
      review.orderId=order.id;
      this.store.db.exec('BEGIN IMMEDIATE');
      try{this.store.saveOrder(order);this.store.set(key,review);this.store.db.exec('COMMIT');}
      catch(e){this.store.db.exec('ROLLBACK');throw e;}
      if(settings.mode==='paper'){order.status='ACTIVE';order.feeBtc=0;this.store.saveOrder(order);}
      else{
        try{
          const result=await this.engine.client().buy(quote,strategy,order.requestId,{twofaToken,destination});
          order.externalId=result.id;order.costBtc=result.costBtc;order.feeBtc=0;
          // A provider result with a missing or unfamiliar status needs reconciliation.
          order.status=normalizeStatus(result.status);
          this.store.saveOrder(order);
          const rt=this.store.get('runtime')||{};this.store.set('runtime',{...rt,balance:Math.max(0,rt.balance-order.costBtc)});
          if(order.costBtc>review.costBtc||order.costBtc>settings.maxOrder)this.engine.pause('Manual purchase execution price exceeded the reviewed ceiling');
          if(order.status==='UNKNOWN')this.engine.pause('Manual purchase returned an unfamiliar status; reconcile it before buying');
        }catch(e){
          const failure=applyPurchaseFailure(order,e);this.store.saveOrder(order);
          await inspectTeamRejection(this.engine,order,e);this.store.saveOrder(order);
          if(!failure.unavailableTeam)this.engine.pause(e.message);this.engine.recordError(e);
        }
      }
      this.store.event(order.status==='UNKNOWN'||order.status==='FAILED'?'warning':'info','Manual '+settings.mode+' purchase: '+order.name+' · '+order.shares+' unit(s) · '+order.status);
      return {order,replayed:false};
    });
  }
}
