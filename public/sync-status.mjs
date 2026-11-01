import {money,paymentMarket} from './money.mjs';

export function acceptedTeamCommitment(o={}){
  if(o.supersededBy||['FAILED','REJECTED','SUPERSEDED'].includes(o.status)||o.attribution?.state==='review'||o.mode!=='live'||o.kind!=='team'||o.accountingOverride||!['PENDING','ACTIVE','COMPLETED'].includes(o.status)||money(o,'feeBtc')!==0)return false;
  const p=o.pendingTeamPurchase;
  if(p){
    if(!p.requestId||money(p,'targetCostBtc')<=0||money(p,'targetCostBtc')!==money(o,'costBtc')||p.targetShares<=0||p.targetShares!==o.shares)return false;
    const entry=o.teamBuys?.find(e=>e.requestId===p.requestId);
    return entry?.status==='PENDING'&&!entry.failure;
  }
  return (o.purchaseReceipts||[]).some(r=>r.requestId&&Number.isFinite(Date.parse(r.at))&&r.totalAmount===money(o,'costBtc')&&r.totalShares===o.shares&&money(o,'costBtc')>0);
}

export function orderSyncBlocksBuying(o={}){
  if(o.supersededBy||['FAILED','REJECTED','SUPERSEDED'].includes(o.status)||(!o.syncPending&&!o.pendingTeamPurchase))return false;
  const p=o.syncPending||{},v=o.fundingVerified||{};
  if(p.blocking===false){
    if(p.proof==='accepted-purchase'&&acceptedTeamCommitment(o))return false;
    if(p.proof==='private-team-member'&&p.verifiedAt&&p.verifiedAt===v.at&&v.market===paymentMarket(o)&&v.amount===money(o,'costBtc')&&!o.pendingTeamPurchase&&o.attribution?.state!=='review'&&!['UNKNOWN','SUBMITTING'].includes(o.status))return false;
  }
  return true;
}

export const buyingHistoryReady=runtime=>runtime?.historyComplete===true||runtime?.buyingReady===true;
const select=(v,keys)=>Object.fromEntries(keys.filter(k=>v?.[k]!==undefined).map(k=>[k,v[k]]));
const privateValues=state=>[state.connection?.organizationId,...[...(state.orders||[]),...(state.strategies||[])].flatMap(o=>[o.payoutAddress,o.mergePayoutAddress])].filter(Boolean);
const redact=(value,values)=>values.reduce((text,secret)=>text.split(secret).join('[redacted]'),String(value??''));

export function syncDiagnostics(state){
  const rt=state.runtime||{},values=privateValues(state);
  const clean=v=>{
    const row=select(v,['stage','source','dbCode','dbExtendedCode','orderId','teamId','blocking','httpStatus','code','method','path','fromPath','toPath','requestId','providerErrorId','checkedAt']);
    for(const key of Object.keys(row))if(!['blocking','httpStatus','dbCode','dbExtendedCode'].includes(key))row[key]=redact(row[key],values);
    if(v?.reason!==undefined)row.reason=redact(v.reason,values);
    return row;
  };
  return {...select(rt,['lastSync','lastBalanceSync','lastTick','lastSyncAttempt','nextSyncAt','historyComplete','buyingReady','syncStatus','syncWarningCount','syncStage','syncStageAt','syncStartedAt','syncFinishedAt','lastHistoryCompleteAt']),
    syncWarnings:(rt.syncWarnings||[]).slice(0,100).map(clean),
    historyReadFallbacks:(rt.historyReadFallbacks||[]).slice(0,20).map(clean),
    ...(rt.lastError?{lastError:redact(rt.lastError,values)}:{}),...(rt.lastErrorDetails?{lastErrorDetails:clean(rt.lastErrorDetails)}:{})};
}

export function syncPhaseLabel(runtime={}){
  return ({clock:'Checking NiceHash time',balances:'Reading account balances','solo-history':'Reading package history','team-history':'Reading team history','team-details':'Verifying team contributions','order-rewards':'Verifying ownership and rewards'})[runtime.syncStage]||'Reading NiceHash account';
}

export function syncIssues(state){
  const values=privateValues(state);
  const clean=value=>redact(value,values);
  return (state.orders||[]).filter(o=>o.mode==='live'&&!o.supersededBy&&o.status!=='SUPERSEDED'&&(o.syncPending||o.pendingTeamPurchase||o.attribution?.state==='review'||['UNKNOWN','SUBMITTING'].includes(o.status))).map(o=>{
    const p=o.syncPending||{};
    const blocking=o.attribution?.state==='review'||['UNKNOWN','SUBMITTING'].includes(o.status)||orderSyncBlocksBuying(o);
    return {...select(o,['id','strategyId','externalId','packageId','requestId','kind','status']),market:paymentMarket(o),
      ...select(p,['since','checkedAt','attempts','stage','source','dbCode','dbExtendedCode','httpStatus','code','method','path','proof','verifiedAt']),
      name:clean(o.name),reason:clean(p.reason||o.attribution?.reason||o.error||(o.pendingTeamPurchase?'Waiting for verification of the team commitment':'Purchase response is unverified')),
      since:p.since||o.createdAt,blocking,
      ...(p.requestId?{syncRequestId:p.requestId}:{}),
      ...(o.pendingTeamPurchase?{pendingRequestId:o.pendingTeamPurchase.requestId,targetAmount:money(o.pendingTeamPurchase,'targetCostBtc'),targetShares:o.pendingTeamPurchase.targetShares}:{}),
      reservedAmount:money(o,'costBtc')+money(o,'feeBtc')-money(o,'refundBtc')};
  });
}

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function historySyncPanel(state){
  const rt=state.runtime||{};
  if(!state.connection?.configured||(!state.connection.verified&&rt.syncStatus!=='syncing')||(rt.historyComplete!==false&&rt.syncStatus!=='syncing'))return '';
  const active=rt.syncStatus==='syncing',ready=buyingHistoryReady(rt),zone=state.settings?.timezone||'Europe/Sofia';
  const date=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('en-GB',{timeZone:zone,dateStyle:'medium',timeStyle:'short'}):'Not recorded';
  const title=active?'Account sync in progress':ready?'Purchases accounted for; details need a retry':'Account history needs attention';
  const automatic=state.settings?.autoSync!==false||(state.settings?.running&&state.settings?.mode==='live');
  const warnings=syncDiagnostics(state).syncWarnings,count=Number(rt.syncWarningCount)||warnings.length;
  return `<section class="callout ${!active&&!ready?'warning':''}"><strong>${title}</strong><p>${active?escape(syncPhaseLabel(rt))+' · Started '+escape(date(rt.syncStartedAt||rt.lastSyncAttempt)):ready?'Other eligible teams can continue within your limits. Personal rewards stay unchanged until details are verified.':'The previous sync could not verify all spending or ownership. Review the reason below; new live purchases stay held until verification succeeds.'}</p>${!active?'<small>Last completed attempt: '+escape(date(rt.syncFinishedAt||rt.lastSync))+(rt.lastHistoryCompleteAt?' · Last fully verified: '+escape(date(rt.lastHistoryCompleteAt)):'')+'</small>':''}${!active&&count?'<p>'+count+' history issue(s).</p>'+warnings.slice(0,5).map(w=>'<div class="sync-issue"><strong>'+escape(w.source==='database'||w.reason==='database is locked'?'Local database write':w.stage||'History check')+(w.httpStatus?' · HTTP '+escape(w.httpStatus):'')+'</strong><p>'+escape(w.reason||'Verification needs a retry')+'</p>'+(w.path?'<small>'+escape(w.method||'GET')+' '+escape(w.path)+'</small>':'')+(w.teamId||w.orderId?'<small>Reference: '+escape(w.teamId||w.orderId)+'</small>':'')+'</div>').join(''):''}${!active&&!warnings.length&&rt.lastError?'<p>'+escape(redact(rt.lastError,privateValues(state)))+'</p>':''}<p>${automatic?'Account sync retries automatically.':'Automatic account sync is disabled. Use Retry account sync to run another check.'}</p><button class="link-btn" data-action="sync">Retry account sync</button> · <button class="link-btn" data-action="purchase-diagnostics">Download purchase diagnostics</button></section>`;
}
export function syncIssuesPanel(state){
  if(state.settings?.mode==='paper')return '';
  const issues=syncIssues(state);if(!issues.length)return '';
  const timezone=state.settings?.timezone||'Europe/Sofia';
  const date=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('en-GB',{timeZone:timezone,dateStyle:'medium',timeStyle:'short'}):'Not recorded';
  return `<section class="callout ${issues.some(i=>i.blocking)?'warning':''}"><strong>Purchase sync details</strong>${issues.slice(0,5).map(i=>`<div class="sync-issue"><strong>${escape(i.name||i.id)} · ${i.blocking?'Buying held':'Background refresh'}</strong><p>${escape(i.reason)}</p><small>Order ${escape(i.externalId||i.id)} · ${escape(i.market)} · Waiting since ${escape(date(i.since))}${i.checkedAt?' · Last checked '+escape(date(i.checkedAt)):''}${i.httpStatus?' · HTTP '+escape(i.httpStatus):''}</small><p>${i.blocking?'The existing reservation stays in spending limits.':'Other teams can continue within your limits. Further additions to this team wait for complete order details.'} <button class="link-btn" data-order="${escape(i.id)}">View package →</button></p></div>`).join('')}${issues.length>5?`<p>${issues.length-5} more issue(s) are included in diagnostics.</p>`:''}<button class="link-btn" data-action="sync">Sync now</button> · <button class="link-btn" data-action="purchase-diagnostics">Download purchase diagnostics</button></section>`;
}
