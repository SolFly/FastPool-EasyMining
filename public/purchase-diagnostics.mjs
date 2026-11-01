import {purchaseProfile} from './request-profiles.mjs';
import {VERSION,guard,pickQuote} from './core.mjs';
import {syncIssues,syncDiagnostics} from './sync-status.mjs';

const select=(value,keys)=>Object.fromEntries(keys.filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
const snapshot=q=>q?select(q,['id','name','market','coin','mergeCoin','status','state','available','quotedAt','buyUntil','sharePriceBtc','sharePriceAmount','joinedShares']):null;
const check=q=>q?{
  ...select(q,['market','checkedAt','clockOffsetMs','selection','fixedTeam','shares','additionalCostBtc','additionalAmount']),
  level:q.level?select(q.level,['threshold','shares']):null,before:snapshot(q.before),finding:q.finding||null,
  after:q.after?{...select(q.after,['checkedAt','listed','httpStatus']),team:snapshot(q.after.team)}:null
}:null;
export function rejectionExplanation(evidence){
  return ({
    'not-listed-after-rejection':'The team was absent from the catalogue read after rejection. Its state at submission is unconfirmed.',
    'closed-after-rejection':'The team was listed as closed or closing after rejection. Its state at submission is unconfirmed.',
    'still-listed-after-rejection':'NiceHash still listed this team as available after rejecting the purchase. The cause is unconfirmed.',
    'verification-read-failed':'The follow-up catalogue read failed, so the team’s state could not be checked.'
  })[evidence?.finding]||'This older failure has no before/after team checks. The log alone does not identify why NiceHash rejected it.';
}
export function purchaseDiagnostics(state,connection={},now=new Date().toISOString()){
  const failures=[];
  for(const order of state.orders||[]){
    if(order.kind!=='team'||order.mode!=='live')continue;
    const add=(failure,extra={})=>{
      if(!failure)return;
      failures.push({orderId:order.id,teamId:order.packageId,orderStatus:order.status,...extra,
        ...select(failure,['at','rejected','uncertain','httpStatus','code','method','path','requestId','purchaseRequestProfile']),
        teamCheck:check(failure.teamCheck||order.purchaseCheck)});
    };
    add(order.submissionFailure);
    if(order.teamBuys?.length){for(const level of order.teamBuys)add(level.failure,{levelThreshold:level.threshold,levelStatus:level.status});}
    else add(order.lastTeamPurchaseFailure);
  }
  failures.sort((a,b)=>(Date.parse(b.at)||0)-(Date.parse(a.at)||0));
  const currentDecisions=(state.strategies||[]).slice(0,100).map(strategy=>{
    try{
      const quote=pickQuote(state.packages||[],strategy,(state.orders||[]).filter(o=>o.mode===state.settings.mode),purchaseProfile(state.settings));
      const reason=guard(state,strategy,quote);
      return {strategyId:strategy.id,mode:strategy.mode,eligible:!reason,reason:reason||'Eligible by the current guards; execution waits for the engine cycle',selectedPackageId:quote?.id||null};
    }catch{return {strategyId:strategy.id,mode:strategy.mode,eligible:false,reason:'Current guards could not be evaluated from the saved data',selectedPackageId:null};}
  });
  return {version:VERSION,exportedAt:now,
    connection:select(connection,['configured','verified','baseUrl','source']),
    settings:select(state.settings,['usdtLimits','purchaseRequestProfile','mode','running','liveArmed','timezone','dailyCap','weeklyCap','monthlyCap','maxOrder','reserve','stopLoss','takeProfit','maxActive','maxErrors']),
    runtime:syncDiagnostics({...state,connection:{...state.connection,...connection}}),
    syncIssues:syncIssues(state),
    teamStrategies:(state.strategies||[]).filter(s=>s.mode==='team').slice(0,100).map(s=>({
      ...select(s,['id','name','market','continuous','coin','packageName','packageId','enabled','shares','minTeamShares','intervalMinutes','maxPrice','budget','maxPurchases','lastBuyAt']),
      teamLevels:(s.teamLevels||[]).map(l=>select(l,['threshold','shares']))
    })),
    currentDecisions,failures:failures.slice(0,20),
    note:'Contains selected team IDs, request references and purchase checks. Excludes API keys, secrets, organization ID, passwords, payout addresses, 2FA, balances and the full ledger. No purchase or retry is performed by export.'};
}
