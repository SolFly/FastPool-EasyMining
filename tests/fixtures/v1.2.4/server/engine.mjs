import {randomUUID,randomInt} from 'node:crypto';
import {NiceHash,normalizeStatus,soloReward} from './nicehash.mjs';
import {teamMembership} from './team-membership.mjs';
import {accountTeamReference,personalSoloProof,automaticImport,manuallyEditedReward} from './order-links.mjs';
import {providerUnits,providerSumUnits} from '../public/provider-amounts.mjs';
import {guard,pickQuote,totals,isPending,isCurrent,isFunded,spendEntries,attributionHeld} from '../public/core.mjs';
import {accountTeamEstimate,purchaseRewardEstimate,personalBlockRewards} from '../public/package-rewards.mjs';
import {rejectedTeamTarget} from '../public/purchase-status.mjs';
import {applyPurchaseFailure,confirmedRejection,legacyTeamRejection} from './purchase-failures.mjs';

const at=()=>new Date().toISOString();
export class Engine {
  constructor(store,{credentials=()=>store.credentials()}={}){this.store=store;this.credentials=credentials;this.busy=false;this.api=null;}
  client(){const c=this.credentials();if(!this.api||['key','secret','orgId','baseUrl'].some(k=>this.api.credentials?.[k]!==c?.[k]))this.api=new NiceHash(c);return this.api;}
  async refreshPackages(){const p=await this.client().packages(),live=this.store.get('settings').mode==='live',orders=this.store.orders();
    if(live)for(const q of p)if(q.team&&rejectedTeamTarget(orders,q.id)){q.available=false;q.availabilityReason='NiceHash rejected this team lobby as unavailable; choose a current matching team';}
    this.store.set('packages',p);await this.refreshRates();return p;}
  async refreshRates({force=false}={}){
    const previous=this.store.get('runtime')||{};
    if(!force&&Date.now()-Date.parse(previous.exchangeRates?.at||0)<300000)return previous.exchangeRates;
    const api=this.client();if(typeof api.exchangeRates!=='function')return previous.exchangeRates;
    try{const exchangeRates=await api.exchangeRates();this.store.set('runtime',{...this.store.get('runtime'),exchangeRates,ratesError:null});return exchangeRates;}
    catch(e){this.store.set('runtime',{...this.store.get('runtime'),ratesError:e.message});return previous.exchangeRates||null;}
  }
  async syncNow(){
    const owner=randomUUID();if(this.busy||!this.store.acquire(owner))throw new Error('Engine is busy. Try again after this cycle.');
    this.busy=true;const heartbeat=setInterval(()=>this.store.renew(owner),20000);
    try{const result=await this.sync();await this.refreshPackages();return result;}
    catch(e){this.recordError(e);throw e;}
    finally{clearInterval(heartbeat);this.busy=false;this.store.release(owner);}
  }
  async background(now=Date.now()){
    if(this.busy)return {busy:true};
    const settings=this.store.get('settings'),runtime=this.store.get('runtime')||{};
    const due=(stamp,seconds)=>!stamp||!Number.isFinite(Date.parse(stamp))||now-Date.parse(stamp)>=seconds*1000;
    if(settings.running&&due(runtime.lastTick,settings.pollSeconds))return this.tick();
    if(settings.autoSync!==false&&this.credentials()&&due(runtime.lastSyncAttempt||runtime.lastSync,settings.accountSyncSeconds||60))return this.syncNow();
    return {idle:true};
  }
  pendingSync(order,reason){
    if(!order||order.accountingOverride||!isCurrent(order))return;
    order.syncPending={since:order.syncPending?.since||at(),reason};this.store.saveOrder(order);
  }
  prepareAttributionAudit(){
    for(const o of this.store.orders().filter(o=>isCurrent(o)&&o.mode==='live'&&o.kind==='solo'&&automaticImport(o)&&o.attribution?.version!==1)){
      o.attribution={state:'review',version:1,at:at(),reason:'Checking imported purchase ownership after the accounting update'};this.store.saveOrder(o);
    }
  }
  repairRejectedAttempts(){
    const rewarded=new Set(this.store.rewards().map(r=>r.orderId));
    for(const o of this.store.orders()){
      const failure=legacyTeamRejection(o);if(!failure||rewarded.has(o.id))continue;
      o.submissionFailure=failure;o.attemptedTeamId=o.externalId;o.externalId=null;o.requestedCostBtc=o.costBtc;o.feeBtc=0;
      delete o.syncPending;
      o.accountingNote='Confirmed rejected purchase attempt; no owned team membership or spending is inferred from its target ID.';
      this.store.saveOrder(o);this.store.event('info','Rejected team attempt released from membership checks: '+o.attemptedTeamId);
    }
  }
  holdAttribution(raw,reason,teamId=null,{create=true}={}){
    let o=this.store.orders().find(o=>isCurrent(o)&&o.mode==='live'&&o.externalId===raw.id);
    if(o?.kind==='team'||(!o&&!create))return o||null;
    if(!o){let cost;try{cost=providerUnits(raw.amount,'unattributed order amount');}catch{return null;}
      o={id:randomUUID(),externalId:raw.id,mode:'live',kind:'solo',name:(raw.soloMiningCoin||'Unattributed')+' imported',coin:raw.soloMiningCoin||'?',source:'NiceHash import',status:normalizeStatus(raw.status),costBtc:cost,feeBtc:0,refundBtc:0,shares:1,createdAt:raw.createdTs||raw.startTs||at()};
    }
    o.attribution={state:'review',version:1,at:o.attribution?.at||at(),reason,teamId:teamId||o.attribution?.teamId||null};
    this.store.saveOrder(o);return o;
  }
  embeddedTeam(raw,embedded){
    if(embedded.orderDetails?.id&&raw.id!==embedded.id&&embedded.orderDetails.id!==raw.id)throw new Error('Embedded team points to a different execution ID');
    const {sharedTicket,...execution}=raw;
    return {...embedded,orderDetails:{...execution,...embedded.orderDetails}};
  }
  async importReferencedTeam(raw,ref,rates=this.store.get('runtime')?.rates||{}){
    this.holdAttribution(raw,'Verifying the personal contribution for this shared execution',ref.teamId,{create:false});
    if(!ref.teamId)throw new Error('Shared reward has no linked team ID. Its amount is excluded until ownership can be verified.');
    let detail=ref.embedded&&teamMembership(ref.embedded,this.credentials()?.orgId).member?this.embeddedTeam(raw,ref.embedded):await this.client().ticket(ref.teamId,true);
    if(String(detail.id).toLowerCase()!==String(ref.teamId).toLowerCase())throw new Error('Team detail returned a different provider ID');
    if(ref.rewardReference&&detail.orderDetails?.id!==raw.id)throw new Error('Reward package reference does not verify the matching team execution');
    if(detail.currencyAlgoTicket?.currencyMarket&&detail.currencyAlgoTicket.currencyMarket!=='BTC')throw new Error('Shared execution returned a different payment currency');
    const result=this.importTeam(detail,rates,{providerOrderIds:[raw.id],purchasedAt:raw.createdTs||raw.startTs});
    if(!result)throw new Error('Waiting for the linked team to identify this organization’s participation');
    return result;
  }
  async sync(){
    this.repairRejectedAttempts();this.prepareAttributionAudit();this.attributionReads=0;
    const api=this.client();if(!api.credentials)throw new Error('Connect a NiceHash API key first');
    this.store.set('runtime',{...this.store.get('runtime'),lastSyncAttempt:at(),syncStatus:'syncing'});
    const ledgerOrg=this.store.get('ledgerOrgId');
    if(ledgerOrg&&String(ledgerOrg).toLowerCase()!==String(api.credentials.orgId).toLowerCase()&&this.store.orders().some(o=>o.mode==='live'))throw new Error('This ledger belongs to another organization. Use a separate application instance.');
    await api.syncClock();
    const balances=await api.balances();
    if(!Array.isArray(balances.currencies))throw new Error('Unexpected NiceHash balance response');
    const btc=balances.currencies.find(c=>c.currency==='BTC'||c.currency==='TBTC');
    if(!btc)throw new Error('BTC balance is missing from account response');
    const balance=providerUnits(btc.available,'BTC available balance');
    const rates=Object.fromEntries(balances.currencies.filter(c=>Number.isFinite(c.btcRate)&&c.btcRate>0).map(c=>[c.currency,c.btcRate]));rates.BTC=1;
    this.store.set('verified',true);
    this.store.set('runtime',{...this.store.get('runtime'),balance,lastBalanceSync:at(),historyComplete:false});
    const account=await api.pages('/main/api/v2/hashpower/solo/order');
    const warnings=[],candidates=new Map(),sharedAccountIds=new Set(),ignoredUsdtIds=new Set();let teams=[];
    const warn=(stage,providerId,e,tracked)=>{
      if([401,403].includes(e.upstreamStatus))throw e;
      warnings.push({stage,...(stage.startsWith('team')?{teamId:providerId}:{orderId:providerId}),reason:e.message,...(e.field?{field:e.field}:{})});
      this.pendingSync(tracked,e.message);
    };
    try{teams=await api.pages('/main/api/v2/hashpower/solo/shared/order',{query:{onlyGold:false}});}
    catch(e){warn('team-history',null,e);}
    this.store.set('ledgerOrgId',api.credentials.orgId);
    const liveTeams=this.store.orders().filter(o=>isCurrent(o)&&isFunded(o)&&o.mode==='live'&&o.kind==='team'&&o.externalId);
    for(const known of liveTeams){sharedAccountIds.add(known.externalId);for(const id of known.providerOrderIds||[])sharedAccountIds.add(id);}
    const addCandidate=(id,extra={})=>{
      const prior=candidates.get(id)||{id,tracked:liveTeams.find(o=>o.externalId===id),accountIds:[]};
      candidates.set(id,{...prior,...extra,accountIds:[...new Set([...prior.accountIds,...(extra.accountIds||[])])]});
    };
    for(const raw of account){
      if(raw.currencyMarket&&raw.currencyMarket!=='BTC'){ignoredUsdtIds.add(raw.sharedTicketId||raw.id);continue;}
      try{
        const known=liveTeams.find(o=>o.externalId===raw.id||o.providerOrderIds?.includes(raw.id));
        const ref=accountTeamReference(raw)|| (known?{teamId:known.externalId,orderId:raw.id,explicit:true}:null);if(!ref)continue;
        const linked=!ref.explicit&&liveTeams.find(o=>o.providerOrderIds?.includes(raw.id));
        sharedAccountIds.add(raw.id);this.holdAttribution(raw,'Verifying this shared execution’s personal contribution',linked?.externalId||ref.teamId,{create:false});
        if(!ref.teamId)throw new Error('Shared reward has no linked team ID; its amount is excluded until attribution is verified');
        addCandidate(linked?.externalId||ref.teamId,{accountIds:[ref.orderId],purchasedAt:raw.createdTs||raw.startTs,provisional:!ref.explicit&&!linked,embedded:ref.embedded,accountRaw:raw,rewardReference:ref.rewardReference});
      }catch(e){sharedAccountIds.add(raw.id);this.holdAttribution(raw,e.message);warn('team-index',raw.id,e,this.store.orders().find(o=>o.externalId===raw.id));}
    }
    let importedTeams=0,catalogueTeamsSkipped=0,importedSolo=0;
    for(const raw of teams){
      const ownership=teamMembership(raw,api.credentials.orgId),tracked=liveTeams.find(o=>o.externalId===raw.id);
      if(!tracked&&!candidates.has(raw.id)&&['unjoined','unrelated'].includes(ownership.state)){catalogueTeamsSkipped++;continue;}
      if(!tracked&&raw.currencyAlgoTicket?.currencyMarket&&raw.currencyAlgoTicket.currencyMarket!=='BTC'){ignoredUsdtIds.add(raw.id);continue;}
      addCandidate(raw.id,{listing:raw});
    }
    const pendingRewardOrders=new Set(this.store.rewards().filter(r=>!r.supersededBy&&!r.confirmed).map(r=>r.orderId));
    for(const tracked of liveTeams){
      if(isPending(tracked)||tracked.syncPending||pendingRewardOrders.has(tracked.id))addCandidate(tracked.externalId);
    }
    for(const candidate of [...candidates.values()].sort((a,b)=>Number(!!(a.provisional&&!a.listing))-Number(!!(b.provisional&&!b.listing)))){
      if(candidate.provisional&&!candidate.listing&&this.store.orders().some(o=>isCurrent(o)&&o.kind==='team'&&o.externalId!==candidate.id&&o.providerOrderIds?.includes(candidate.id)))continue;
      try{
        const detail=candidate.embedded&&teamMembership(candidate.embedded,api.credentials.orgId).member?this.embeddedTeam(candidate.accountRaw,candidate.embedded):await api.ticket(candidate.id,true);
        if(String(detail.id).toLowerCase()!==String(candidate.id).toLowerCase())throw new Error('Team detail returned a different provider ID');
        if(candidate.rewardReference&&detail.orderDetails?.id!==candidate.accountRaw.id)throw new Error('Reward reference did not verify this team execution');
        if(detail.currencyAlgoTicket?.currencyMarket&&detail.currencyAlgoTicket.currencyMarket!=='BTC'){
          if(candidate.tracked)throw new Error('Tracked BTC team purchase returned a different payment currency');
          ignoredUsdtIds.add(candidate.id);continue;
        }
        const imported=this.importTeam(detail,rates,{providerOrderIds:candidate.accountIds,purchasedAt:candidate.purchasedAt});
        if(imported){
          importedTeams++;sharedAccountIds.add(imported.externalId);for(const id of imported.providerOrderIds||[])sharedAccountIds.add(id);
          if(imported.syncPending||imported.status==='UNKNOWN')warn('team-confirmation',candidate.id,new Error(imported.syncPending?.reason||imported.error||'Team payment confirmation is still pending'),imported);
        }else warn('team-membership',candidate.id,new Error('Waiting for NiceHash to return your organization’s participation; account sync will retry.'),candidate.tracked);
      }catch(e){if(candidate.accountRaw)this.holdAttribution(candidate.accountRaw,e.message,candidate.id);warn('team-detail',candidate.id,e,candidate.tracked);}
    }
    // The solo/order index includes shared executions. Never import their whole
    // team amount or reward as a personal solo purchase.
    for(const raw of account){
      if(sharedAccountIds.has(raw.id)||(raw.currencyMarket&&raw.currencyMarket!=='BTC'))continue;
      try{const imported=await this.importSolo(raw);if(imported?.kind==='team'){importedTeams++;if(imported.syncPending||imported.status==='UNKNOWN')warn('team-confirmation',imported.externalId,new Error(imported.syncPending?.reason||imported.error||'Team confirmation is pending'),imported);}else importedSolo++;}
      catch(e){warn('solo-detail',raw.id,e,this.store.orders().find(o=>o.mode==='live'&&o.externalId===raw.id));}
    }
    const known=new Set(account.map(o=>o.id));
    for(const o of this.store.orders().filter(o=>isCurrent(o)&&o.mode==='live'&&o.externalId&&o.kind==='solo'&&(isPending(o)||o.syncPending||attributionHeld(o))&&!known.has(o.externalId))){
      try{if(attributionHeld(o)){if(this.attributionReads>=25)throw new Error('Ownership audit is continuing automatically in the next account sync');this.attributionReads++;}await this.importSolo(await api.ticket(o.externalId));}
      catch(e){warn('solo-detail',o.externalId,e,o);}
    }
    for(const o of this.store.orders().filter(o=>isCurrent(o)&&o.mode==='live'&&attributionHeld(o)))if(!warnings.some(w=>w.orderId===o.externalId||w.teamId===o.externalId))warnings.push({stage:'attribution',orderId:o.externalId,reason:o.attribution.reason});
    const runtime=this.store.get('runtime')||{},historyComplete=warnings.length===0,ignoredUsdt=ignoredUsdtIds.size;
    this.store.set('runtime',{...runtime,lastSync:at(),balance,rates,ignoredUsdt,errors:0,lastError:null,lastErrorDetails:null,
      historyComplete,syncStatus:historyComplete?'ready':'waiting',syncWarnings:warnings.slice(0,100),syncWarningCount:warnings.length,importedTeams,catalogueTeamsSkipped,
      nextSyncAt:new Date(Date.now()+(this.store.get('settings').accountSyncSeconds||60)*1000).toISOString()});
    this.store.set('verified',true);
    if(runtime.historyComplete===false&&historyComplete)this.store.event('info','Account history recovered automatically; verified purchases and budgets are up to date');
    // A temporary read/history gap only holds new purchases. Running/arming
    // intent is preserved so a verified sync can recover without a new password.
    return {balance,solo:importedSolo,teams:importedTeams,teamRowsReturned:teams.length,catalogueTeamsSkipped,ignoredUsdt,historyComplete,warnings:warnings.slice(0,100)};
  }
  async importSolo(raw){
    if(!raw.id||raw.amount===undefined)throw new Error('Ticket schema is missing ID or amount');
    const original=raw;
    let proof;
    try{
      let rewards=raw.soloReward;
      if(!Array.isArray(rewards))rewards=await this.client().request('GET','/main/api/v2/hashpower/order/'+raw.id+'/rewards');
      if(!Array.isArray(rewards))throw new Error('Unexpected reward response schema');
      raw={...raw,soloReward:rewards};
      let ref=accountTeamReference(raw);if(ref)return await this.importReferencedTeam(raw,ref);
      const previous=this.store.orders().find(o=>isCurrent(o)&&o.externalId===raw.id);
      proof=personalSoloProof(raw,this.credentials()?.orgId);
      if(!proof&&!raw.organizationId&&previous?.attribution?.state==='personal'&&previous.attribution.organizationId===this.credentials()?.orgId)proof=previous.attribution.proof;
      if(!proof){
        if((this.attributionReads||0)>=25)throw new Error('Ownership audit is continuing automatically in the next account sync');
        this.attributionReads=(this.attributionReads||0)+1;
        const detail=await this.client().ticket(raw.id);
        if(detail.id!==raw.id)throw new Error('Private order detail returned a different provider ID');
        raw={...raw,...detail,soloReward:Array.isArray(detail.soloReward)?detail.soloReward:rewards};
        ref=accountTeamReference(raw);if(ref)return await this.importReferencedTeam(raw,ref);
        proof=personalSoloProof(raw,this.credentials()?.orgId);
        if(!proof)throw new Error('The API has not verified personal ownership of this order. Cost and rewards are excluded from reports while account sync retries.');
      }
    }catch(e){this.holdAttribution(original,e.message);throw e;}
    this.store.db.exec('SAVEPOINT solo_import');
    try{const result=this.importSoloData(raw,proof);this.store.db.exec('RELEASE solo_import');return result;}
    catch(e){this.store.db.exec('ROLLBACK TO solo_import; RELEASE solo_import');throw e;}
  }
  importSoloData(raw,proof){
    if(!raw.id||raw.amount===undefined)throw new Error('Ticket schema is missing ID or amount');
    if(accountTeamReference(raw)||!proof)throw new Error('Solo import requires verified personal order ownership');
    let o=this.store.orders().find(o=>o.externalId===raw.id);
    // A request ID match is safe; matching by price/time alone is intentionally forbidden.
    if(!o&&raw.requestId)o=this.store.orders().find(o=>o.requestId===raw.requestId);
    if(o?.supersededBy)return o;
    const cost=providerUnits(raw.amount,'solo order amount');
    const status=normalizeStatus(raw.status);
    if(!o)o={id:randomUUID(),externalId:raw.id,mode:'live',kind:'solo',strategyId:null,name:raw.soloMiningCoin+' imported',coin:raw.soloMiningCoin||'?',
      createdAt:raw.createdTs||raw.startTs||at(),packageId:null,shares:1,costBtc:cost,feeBtc:0,refundBtc:0,source:'NiceHash import'};
    o.externalId=raw.id;o.status=status;o.costBtc=cost;o.feeBtc=0;o.endAt=raw.endTs||o.endAt;
    o.attribution={state:'personal',version:1,at:at(),organizationId:this.credentials()?.orgId,proof};
    delete o.syncPending;delete o.error;
    o.payoutAddress=raw.soloMiningRewardAddr||o.payoutAddress||'';o.mergeCoin=raw.soloMiningMergeCoin||o.mergeCoin||null;
    o.accountingNote='Order amount reported by NiceHash. Package price is treated as inclusive; ambiguous refunds require reconciliation.';
    if(['CANCELLED','ERROR','ERROR_ON_CREATION','ERROR_ON_CREATION_ON_REVERTING_TRANSACTIONS'].includes(raw.status?.code||raw.status)){
      o.status='UNKNOWN';o.accountingNote='Cancelled/error order: verify refund and final debit before resolving.';
    }
    if(o.accountingOverride){Object.assign(o,o.accountingOverride.values);o.accountingNote='Manually reconciled: '+o.accountingOverride.note;}
    this.store.saveOrder(o);
    let rewards=raw.soloReward;
    if(!Array.isArray(rewards))throw new Error('Unexpected reward response schema');
    for(const r of rewards){
      const prev=this.store.rewards().find(x=>x.id===r.id);this.store.reward(soloReward(r,o.id,prev));
    }
    return o;
  }
  importTeam(raw,rates={},context={}){
    this.store.db.exec('SAVEPOINT team_import');
    try{const result=this.importTeamData(raw,rates,context);this.store.db.exec('RELEASE team_import');return result;}
    catch(e){this.store.db.exec('ROLLBACK TO team_import; RELEASE team_import');throw e;}
  }
  importTeamData(raw,rates={},context={}){
    const m=teamMembership(raw,this.credentials()?.orgId).member;
    if(!m){
      const tracked=this.store.orders().find(o=>o.mode==='live'&&o.externalId===raw.id);
      this.pendingSync(tracked,'Waiting for this organization’s team membership; existing cost remains reserved');
      return null;
    }
    let o=this.store.orders().find(o=>o.externalId===raw.id);
    const prior=o&&o.kind==='team'?structuredClone(o):null;
    if(o?.kind==='solo'){
      if(!automaticImport(o)||this.store.rewards().some(r=>r.orderId===o.id&&manuallyEditedReward(r)))throw new Error('A manually edited solo record conflicts with this team; review its accounting');
      for(const r of this.store.rewards().filter(r=>r.orderId===o.id&&!r.teamId)){r.supersededBy='team:'+raw.id;this.store.reward(r);}
      o.kind='team';o.packageId=raw.id;o.coin=raw.currencyAlgoTicket?.currencyAlgo?.currency||o.coin;
      o.accountingNote='Corrected an imported shared execution to its verified personal team contribution';
    }
    if(!o)o={id:randomUUID(),externalId:raw.id,mode:'live',kind:'team',strategyId:null,name:raw.currencyAlgoTicket?.name||'Imported team',coin:raw.currencyAlgoTicket?.currencyAlgo?.currency||'?',
      createdAt:context.purchasedAt||raw.createdTs||at(),packageId:raw.id,shares:m.shares?.small||1,feeBtc:0,refundBtc:0,source:'NiceHash import'};
    o.kind='team';o.packageId=raw.id;
    o.attribution={state:'team-member',version:1,at:at(),organizationId:this.credentials()?.orgId,proof:'matching organization in team membership'};
    o.rewardEstimate=accountTeamEstimate(raw,m);
    o.shares=o.rewardEstimate.memberShares??m.shares?.small??o.shares??1;
    o.payoutAddress=m.soloMiningRewardAddr||o.payoutAddress||'';
    o.mergePayoutAddress=m.mergeSoloMiningRewardAddr||o.mergePayoutAddress||'';
    o.mergeCoin=raw.currencyAlgoTicket?.mergeCurrencyAlgo?.currency||o.mergeCoin||null;
    const memberCost=providerUnits(m.addedAmount,'team member addedAmount');
    if(['UNKNOWN','SUBMITTING'].includes(o.status)&&!automaticImport(o)&&memberCost<o.costBtc&&m.paymentStatus!=='RETURNED'){
      o.status='UNKNOWN';o.error='Team membership does not yet confirm the full submitted amount';this.store.saveOrder(o);return o;
    }
    o.costBtc=m.paymentStatus==='RETURNED'?Math.max(o.costBtc||0,memberCost):memberCost;o.feeBtc=0;
    o.status=raw.orderDetails?.status&&normalizeStatus(raw.orderDetails.status)!=='UNKNOWN'?normalizeStatus(raw.orderDetails.status):normalizeStatus(raw.status);o.endAt=raw.orderDetails?.endTs||raw.lifeTimeTill;
    delete o.error;delete o.syncPending;delete o.rewardPrecisionNote;
    if(m.paymentStatus==='RETURNED'){o.refundBtc=o.costBtc;o.status='CANCELLED';}
    else if(['FAILED','RETURNED_FAILED'].includes(m.paymentStatus)){o.status='UNKNOWN';o.syncPending={since:at(),reason:'Waiting for NiceHash to resolve team payment status '+m.paymentStatus};}
    o.providerOrderIds=[...new Set([...(o.providerOrderIds||[]),...(context.providerOrderIds||[]),...(raw.orderDetails?.id?[raw.orderDetails.id]:[])])].filter(id=>id&&id!==raw.id);
    for(const alias of this.store.orders().filter(x=>isCurrent(x)&&x.id!==o.id&&x.mode==='live'&&o.providerOrderIds.includes(x.externalId))){
      if(alias.kind!=='solo'||!automaticImport(alias)||this.store.rewards().some(r=>r.orderId===alias.id&&manuallyEditedReward(r)))throw new Error('A manually edited record conflicts with a verified team execution; review its accounting');
      alias.supersededBy=o.id;alias.status='SUPERSEDED';alias.accountingNote='Duplicate shared execution linked to verified team '+raw.id+'; excluded from spending and reward totals';this.store.saveOrder(alias);
      this.store.event('info','Shared execution duplicate linked to its personal team contribution: '+raw.id);
    }
    if(o.accountingOverride){Object.assign(o,o.accountingOverride.values);o.accountingNote='Manually reconciled: '+o.accountingOverride.note;}
    if(prior){
      const before=prior.costBtc+(prior.feeBtc||0)-(prior.refundBtc||0),after=o.costBtc+(o.feeBtc||0)-(o.refundBtc||0);
      if(after!==before)o.spendHistory=[...spendEntries(prior),{at:at(),amountBtc:after-before,note:'Team contribution/refund change first observed by account sync'}];
    }
    this.store.saveOrder(o);
    if(m.rewards!==undefined&&m.rewards!==null&&!Array.isArray(m.rewards))throw new Error('NiceHash team member rewards: expected an array');
    const memberRewards=m.rewards??(m.rewardAmount!=null?[{coin:o.coin,rewardAmount:m.rewardAmount,rewardFeeAmount:m.rewardFeeAmount??0}]:[]);
    const grouped=new Map();
    for(const row of memberRewards){
      const coin=row?.coin||row?.currency;
      if(!/^[A-Z0-9]{2,12}$/.test(coin||''))throw new Error('NiceHash team reward: missing or invalid coin');
      const group=grouped.get(coin)||{coin,amounts:[],fees:[]};group.amounts.push(row.rewardAmount);group.fees.push(row.rewardFeeAmount??0);grouped.set(coin,group);
    }
    for(const r of grouped.values()){
      const group='team:'+raw.id+':'+r.coin;
      const pieces=this.store.rewards().filter(x=>x.teamId===raw.id&&x.coin===r.coin);
      // NiceHash's member rewardAmount is the payable net amount. Its UI adds
      // rewardFeeAmount to it to show the gross total; do not deduct that fee twice.
      const net=providerSumUnits(r.amounts,'team '+r.coin+' reward.rewardAmount'),amount=net.amount;
      const fee=providerSumUnits(r.fees,'team '+r.coin+' reported fee');
      o.reportedRewardFees={...o.reportedRewardFees,[r.coin]:fee.amount};
      if(net.rounded){o.rewardPrecisionNote='The provider reports payout fractions below 0.00000001 coin. This ledger rounds the cumulative personal net payout down to 8 decimal places.';this.store.saveOrder(o);}
      const recorded=pieces.reduce((n,x)=>n+x.amount,0);
      if(amount<recorded){
        o.status='UNKNOWN';o.error='Provider team reward total decreased; verify payout adjustments';
        o.attribution={state:'review',version:1,at:at(),teamId:raw.id,reason:'The current personal payout is below the recorded total. Financial reporting excludes this order until the adjustment is verified.'};
        this.store.saveOrder(o);continue;
      }
      const cumulativeId=group+':'+amount;
      if(amount>recorded)pieces.push({id:pieces.some(x=>x.id===cumulativeId)?cumulativeId+':from:'+recorded:cumulativeId,orderId:o.id,teamId:raw.id,coin:r.coin,
        amount:amount-recorded,createdAt:pieces.length?at():(raw.orderDetails?.endTs||at()),confirmed:false,valueBtc:null});
      const providerConfirmed=m.claimed===true&&(raw.orderDetails?.soloReward||[]).some(x=>x.coin===r.coin&&x.depositComplete===true);
      for(const piece of pieces){
        piece.scope='team-member';
        if(!piece.confirmed){
          piece.valueBtc=r.coin==='BTC'?piece.amount:(Number.isFinite(rates[r.coin])?Math.round(piece.amount*rates[r.coin]):null);
          piece.confirmed=providerConfirmed||!!piece.manualConfirmed;
          if(piece.confirmed)piece.confirmedAt=at();
        }
        if(!manuallyEditedReward(piece))piece.valuation='NiceHash reported personal net member payout at account BTC rate; separately reported fees are not deducted again';
        this.store.reward(piece);
      }
    }
    this.store.saveOrder(o);
    return o;
  }
  async tick({manual=false}={}){
    const owner=randomUUID();if(this.busy||!this.store.acquire(owner))return {busy:true};
    this.busy=true;const heartbeat=setInterval(()=>this.store.renew(owner),20000);
    try{
      let settings=this.store.get('settings');
      if(!settings.running&&!manual)return {paused:true};
      // History can take time to audit. Fetch the buyable catalogue after that
      // work so a short-lived team lobby is as fresh as possible at submission.
      if(settings.mode==='live'){await this.sync();await this.refreshPackages();}
      else{await this.refreshPackages();this.settlePaper();}
      const decisions=[];
      for(const strategy of this.store.strategies()){
        if(this.store.get('settings').mode!==settings.mode||!this.store.owns(owner))break;
        const state=this.store.state(),q=pickQuote(state.packages,strategy,state.orders.filter(o=>o.mode===settings.mode)),reason=guard(state,strategy,q);
        decisions.push({id:strategy.id,name:strategy.name,reason:reason||'Ready to buy',quote:q});
        if(reason)continue;
        const previousBuyAt=strategy.lastBuyAt;
        const o={id:randomUUID(),requestId:randomUUID(),mode:settings.mode,kind:strategy.mode,strategyId:strategy.id,
          packageId:q.id,name:q.name,coin:q.coin,mergeCoin:q.mergeCoin,
          payoutAddress:strategy.payoutAddress||'',mergePayoutAddress:strategy.mergePayoutAddress||'',shares:strategy.mode==='team'?strategy.shares:1,
          costBtc:q.costBtc,feeBtc:Math.ceil(q.costBtc*settings.feeBufferBps/10000),refundBtc:0,
          createdAt:at(),status:'SUBMITTING',odds:q.odds,reward:q.reward,
          rewardEstimate:purchaseRewardEstimate(state.packages.find(p=>p.id===q.id),strategy.mode==='team'?strategy.shares:1),
          endAt:new Date(Date.now()+q.duration*1000).toISOString(),source:settings.mode==='paper'?'Paper simulation':'Strategy engine',
          externalId:settings.mode==='live'&&strategy.mode==='team'?q.id:null};
        this.store.saveOrder(o);strategy.lastBuyAt=at();this.store.strategy(strategy);
        if(settings.mode==='paper'){
          o.status='ACTIVE';o.feeBtc=0;this.store.saveOrder(o);this.store.event('info','Paper purchase: '+q.name+' · '+o.shares+' unit(s)');
        }else{
          try{
            const result=await this.client().buy(q,strategy,o.requestId);
            o.externalId=result.id;o.costBtc=result.costBtc;o.feeBtc=0;o.status=normalizeStatus(result.status);
            this.store.saveOrder(o);
            const rt=this.store.get('runtime')||{};rt.balance=Math.max(0,rt.balance-o.costBtc);this.store.set('runtime',rt);
            this.store.event('info','Live purchase accepted: '+q.name+' · '+result.id);
            if(o.costBtc>strategy.maxPrice||o.costBtc>settings.maxOrder){this.pause('Provider execution price exceeded the checked ceiling');break;}
          }catch(e){
            const failure=applyPurchaseFailure(o,e);this.store.saveOrder(o);
            if(confirmedRejection(e)){strategy.lastBuyAt=previousBuyAt;this.store.strategy(strategy);}
            if(!failure.unavailableTeam)this.pause(e.message);
            this.recordError(e);break;
          }
        }
      }
      const rt=this.store.get('runtime')||{};this.store.set('runtime',{...rt,lastTick:at(),decisions});
      return {decisions};
    }catch(e){this.recordError(e);throw e;}
    finally{clearInterval(heartbeat);this.busy=false;this.store.release(owner);}
  }
  settlePaper(){
    const rates=this.store.get('runtime')?.rates||{BTC:1};
    for(const o of this.store.orders().filter(o=>o.mode==='paper'&&o.status==='ACTIVE'&&Date.parse(o.endAt)<=Date.now())){
      o.status='COMPLETED';this.store.saveOrder(o);
      if(randomInt(1000000000)/1000000000<1/Math.max(1,o.odds||Infinity)){
        // Legacy solo records have full ownership. Team records require their
        // purchase snapshot even after disappearing from the live catalogue.
        if(!o.rewardEstimate&&o.kind!=='team')o.rewardEstimate=purchaseRewardEstimate({coin:o.coin,reward:o.reward,team:false},1);
        const blocks=personalBlockRewards(o).filter(b=>b.coin===o.coin);
        if(!blocks.length){o.rewardEstimateNote='Simulated block found, but the historical personal allocation is unavailable. No reward was credited.';this.store.saveOrder(o);this.store.event('warning',o.rewardEstimateNote+' '+o.name);continue;}
        for(const block of blocks)this.store.reward({id:'paper:'+o.id+':'+block.coin,orderId:o.id,coin:block.coin,amount:block.amount,confirmed:true,
          scope:o.kind==='team'?'team-member':'solo',valueBtc:rates[block.coin]?Math.round(block.amount*rates[block.coin]):null,createdAt:at(),valuation:'SIMULATED personal block reward from purchase allocation; not a NiceHash payout'});
        this.store.saveOrder(o);this.store.event('info','Simulated personal reward: '+o.name);
      }
    }
  }
  pause(reason){const s=this.store.get('settings');s.running=false;s.liveArmed=false;this.store.set('settings',s);this.store.event('warning','Engine paused: '+reason);}
  recordError(e){
    const rt=this.store.get('runtime')||{};rt.errors=(rt.errors||0)+1;rt.lastError=e.message;rt.lastTick=at();
    rt.lastErrorDetails=e.code==='NICEHASH_API_ERROR'?{provider:'NiceHash',httpStatus:e.upstreamStatus,code:e.nicehashCode,message:e.providerMessage||null,method:e.method,path:e.path,requestId:e.requestId,clockOffsetMs:e.clockOffsetMs}:null;
    this.store.set('runtime',rt);this.store.event('error',e.message);
    if([401,403].includes(e.upstreamStatus)){
      this.store.set('verified',false);this.store.set('runtime',{...rt,syncStatus:'authentication-error',historyComplete:false});
      this.pause('NiceHash rejected authentication or API permissions');
    }
    else if(confirmedRejection(e)){
      // A rejected purchase is not a failed account-history read. Retain the
      // actual result of the last sync, including any genuine existing holds.
      this.store.set('runtime',{...rt,lastPurchaseRejection:rt.lastErrorDetails});
    }
    // Read errors hold buying and retry in the background. Authentication and
    // actual purchase uncertainty still require the existing explicit re-arm.
    else this.store.set('runtime',{...rt,syncStatus:'retrying',historyComplete:false,
      nextSyncAt:new Date(Date.now()+(this.store.get('settings').accountSyncSeconds||60)*1000).toISOString()});
  }
}
