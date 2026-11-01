import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULTS,STRATEGY_DEFAULTS,guard} from '../public/core.mjs';
import {fundingRecord} from '../public/money.mjs';
import {acceptedTeamCommitment,orderSyncBlocksBuying,syncIssues,syncIssuesPanel,historySyncPanel,syncDiagnostics} from '../public/sync-status.mjs';
import {syncPresentation} from '../public/runtime-status.mjs';
import {purchaseDiagnostics} from '../public/purchase-diagnostics.mjs';
const now=Date.parse('2026-10-31T18:00:00Z');
const pending=market=>fundingRecord(market,{id:'order',mode:'live',kind:'team',strategyId:'first',name:'Team Silver',status:'PENDING',costBtc:10000,feeBtc:0,shares:1,
  createdAt:'2026-10-31T12:00:00Z',pendingTeamPurchase:fundingRecord(market,{requestId:'accepted',targetCostBtc:10000,targetShares:1}),
  teamBuys:[{requestId:'accepted',status:'PENDING',shares:1}],syncPending:{since:'2026-10-31T12:00:00Z',checkedAt:'2026-10-31T17:59:00Z',blocking:false,proof:'accepted-purchase',httpStatus:404,reason:'Details are delayed'}});
const state=order=>({settings:{...DEFAULTS,mode:'live',running:true,liveArmed:true,feeBufferBps:0,startHour:'00:00',endHour:'23:59'},
  runtime:{lastSync:new Date(now).toISOString(),balance:2000000,historyComplete:false,buyingReady:true,syncStatus:'waiting'},connection:{configured:true,verified:true},orders:[order],rewards:[],packages:[],strategies:[]});
const strategy={...STRATEGY_DEFAULTS,id:'second',enabled:true,continuous:true,mode:'solo',lastBuyAt:null};
const quote={id:'solo',coin:'BTC',market:'BTC',available:true,costBtc:10000,team:false,quotedAt:new Date(now).toISOString()};

test('acknowledged BTC and USDT waits hold only their team and retain the full spending limit',()=>{
  for(const market of ['BTC','USDT']){
    const o=pending(market),s=state(o);
    assert.equal(acceptedTeamCommitment(o),true);assert.equal(orderSyncBlocksBuying(o),false);
    assert.equal(guard(s,strategy,quote,now),null);
    assert.equal(syncPresentation(s).engine,'Engine running');assert.equal(syncPresentation(s).background.length,1);
    if(market==='BTC'){s.settings.dailyCap=19999;assert.equal(guard(s,strategy,quote,now),'Daily spending cap');}
    const issues=syncIssues(s);assert.equal(issues[0].blocking,false);assert.equal(issues[0].reservedAmount,10000);assert.equal(issues[0].since,'2026-10-31T12:00:00Z');
  }
});

test('unknown responses, unproven flags and differing totals still hold buying after any age',()=>{
  for(const alter of [o=>o.status='UNKNOWN',o=>o.teamBuys[0].status='UNKNOWN',o=>o.teamBuys[0].failure={uncertain:true},o=>o.pendingTeamPurchase.targetCostBtc=20000,o=>o.syncPending.proof='unproven',o=>o.attribution={state:'review'}]){
    const o=pending('BTC');alter(o);assert.equal(orderSyncBlocksBuying(o),true);
    assert.notEqual(guard(state(o),strategy,quote,now),null);
    assert.equal(syncPresentation(state(o)).waiting,true);
  }
});

test('private membership proof is bound to its checked timestamp, currency and amount',()=>{
  const o=pending('BTC');delete o.pendingTeamPurchase;
  o.fundingVerified={at:'verified-now',market:'BTC',amount:10000};o.syncPending={blocking:false,proof:'private-team-member',verifiedAt:'verified-now'};
  assert.equal(orderSyncBlocksBuying(o),false);
  o.fundingVerified.market='USDT';assert.equal(orderSyncBlocksBuying(o),true);
  o.fundingVerified.market='BTC';o.fundingVerified.amount=9999;assert.equal(orderSyncBlocksBuying(o),true);
  o.fundingVerified.amount=10000;o.syncPending.verifiedAt='earlier';assert.equal(orderSyncBlocksBuying(o),true);
});

test('sync issue UI identifies blocking order, retries and time while escaping provider text',()=>{
  const o=pending('BTC');o.name='<img src=x>';o.syncPending.blocking=true;o.syncPending.reason='<script>untrusted</script>';
  const html=syncIssuesPanel(state(o));
  assert.match(html,/Buying held/);assert.match(html,/31 Oct 2026/);assert.match(html,/HTTP 404/);assert.match(html,/Download purchase diagnostics/);
  assert.match(html,/data-order="order"/);assert.doesNotMatch(html,/<script>|<img/);
  const paper=state(o);paper.settings.mode='paper';assert.equal(syncIssuesPanel(paper),'');
});

test('diagnostics include pending sync evidence and redact payout values',()=>{
  const o=pending('BTC');o.payoutAddress='private-payout';o.syncPending.reason='Delayed private-payout';o.syncPending.requestId='detail-request';
  const d=purchaseDiagnostics(state(o));assert.equal(d.syncIssues[0].pendingRequestId,'accepted');assert.equal(d.syncIssues[0].syncRequestId,'detail-request');
  assert.equal(d.runtime.buyingReady,true);assert.doesNotMatch(JSON.stringify(d),/private-payout/);
});

test('a finished history failure shows attention and its exact request instead of active progress',()=>{
  const s=state(pending('BTC'));s.orders=[];
  Object.assign(s.runtime,{buyingReady:false,syncWarningCount:1,syncStage:'waiting',syncFinishedAt:'2026-10-31T17:55:00Z',syncWarnings:[{stage:'team-history',method:'GET',path:'/hashpower/api/v2/hashpower/solo/shared/order',httpStatus:404,reason:'History endpoint unavailable'}]});
  assert.match(syncPresentation(s).connectionText,/history needs attention.*1 issue/);
  assert.doesNotMatch(syncPresentation(s).connectionText,/updating/);
  const html=historySyncPanel(s);assert.match(html,/Last completed attempt/);assert.match(html,/HTTP 404/);assert.match(html,/GET \/hashpower\/api\/v2\/hashpower\/solo\/shared\/order/);assert.match(html,/Retry account sync/);
  assert.doesNotMatch(html,/Account sync in progress/);
  const d=purchaseDiagnostics(s);assert.equal(d.runtime.syncWarnings[0].stage,'team-history');assert.equal(d.runtime.syncWarnings[0].httpStatus,404);assert.equal(d.syncIssues.length,0);
});

test('active sync shows its actual phase and recovery clears the waiting presentation',()=>{
  const s=state(pending('BTC'));s.orders=[];
  Object.assign(s.runtime,{syncStatus:'syncing',syncStage:'team-history',syncStartedAt:'2026-10-31T17:55:00Z'});
  assert.match(syncPresentation(s).connectionText,/Syncing NiceHash · Reading team history/);
  assert.match(historySyncPanel(s),/Account sync in progress/);
  Object.assign(s.runtime,{syncStatus:'ready',syncStage:'ready',historyComplete:true,buyingReady:true,syncWarnings:[],syncWarningCount:0});
  assert.equal(historySyncPanel(s),'');assert.equal(syncPresentation(s).connectionText,'Connected & verified');assert.equal(syncPresentation(s).engine,'Engine running');
});

test('history diagnostic export preserves failure evidence while excluding private response fields',()=>{
  const s=state(pending('BTC'));s.connection.organizationId='private-org';s.orders[0].payoutAddress='private-payout';
  s.runtime.syncWarnings=[{stage:'team-history',httpStatus:404,reason:'private-org private-payout <script>x</script>',requestId:'request-ref',privateResponse:{secret:'unexported-token'}}];
  s.runtime.buyingReady=false;s.runtime.syncWarningCount=1;
  const diagnostic=syncDiagnostics(s);assert.equal(diagnostic.syncWarnings[0].requestId,'request-ref');assert.doesNotMatch(JSON.stringify(diagnostic),/private-org|private-payout|unexported-token/);
  const html=historySyncPanel(s);assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);
});

test('paused account with automatic sync disabled gives an explicit manual retry instruction',()=>{
  const s=state(pending('BTC'));Object.assign(s.settings,{running:false,autoSync:false});s.runtime.buyingReady=false;
  assert.match(historySyncPanel(s),/Automatic account sync is disabled/);assert.match(historySyncPanel(s),/Retry account sync/);
  assert.equal(syncPresentation(s).engine,'Engine paused');
});

test('local database write failures are distinguished from NiceHash request failures',()=>{
  const s=state(pending('BTC'));s.runtime.buyingReady=false;
  s.runtime.syncWarningCount=1;s.runtime.syncWarnings=[{stage:'team-detail',source:'database',dbCode:5,dbExtendedCode:517,reason:'database is locked',blocking:true}];
  const html=historySyncPanel(s);assert.match(html,/Local database write/);assert.match(html,/database is locked/);assert.doesNotMatch(html,/HTTP 5|GET undefined/);
  const d=purchaseDiagnostics(s);assert.equal(d.runtime.syncWarnings[0].dbCode,5);assert.equal(d.runtime.syncWarnings[0].dbExtendedCode,517);assert.equal(d.runtime.syncWarnings[0].source,'database');
});
