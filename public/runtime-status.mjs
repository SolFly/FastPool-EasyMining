import {isCurrent,isFunded,attributionHeld} from './core.mjs';
import {orderSyncBlocksBuying,buyingHistoryReady,syncPhaseLabel} from './sync-status.mjs';
export function syncPresentation(state){
  const settings=state.settings||{},runtime=state.runtime||{},connection=state.connection||{};
  const orders=(state.orders||[]).filter(o=>isCurrent(o)&&o.mode===settings.mode);
  const checking=orders.filter(o=>attributionHeld(o)||(isFunded(o)&&(o.syncPending||o.pendingTeamPurchase))||(['UNKNOWN','SUBMITTING'].includes(o.status)&&o.externalId));
  const unresolved=orders.filter(o=>['UNKNOWN','SUBMITTING'].includes(o.status)&&!o.externalId&&!o.syncPending);
  const background=checking.filter(o=>!attributionHeld(o)&&!['UNKNOWN','SUBMITTING'].includes(o.status)&&!orderSyncBlocksBuying(o));
  const waiting=settings.mode==='live'&&((runtime.historyComplete===false&&!buyingHistoryReady(runtime))||checking.length>background.length||runtime.syncStatus==='retrying');
  const automatic=!!connection.configured&&(settings.autoSync!==false||(settings.running&&settings.mode==='live'));
  const engine=settings.running?(waiting?'Waiting for account sync':'Engine running'):'Engine paused';
  const issueCount=Number(runtime.syncWarningCount)||(runtime.syncWarnings||[]).length;
  let connectionText=!connection.configured?'Not connected · paper mode is available':!connection.verified?'Connection awaiting verification':runtime.historyComplete===false?'Balance verified · history needs attention'+(issueCount?' · '+issueCount+' issue(s)':''):'Connected & verified';
  if(connection.configured&&runtime.syncStatus==='syncing')connectionText='Syncing NiceHash · '+syncPhaseLabel(runtime);
  else if(connection.verified&&runtime.historyComplete===false&&runtime.buyingReady===true)connectionText='Balance verified · order details refreshing';
  else if(connection.configured&&runtime.syncStatus==='retrying')connectionText='Connection retry pending · account sync will retry';
  else if(connection.configured&&runtime.syncStatus==='authentication-error')connectionText='API credentials or permissions need attention';
  return {checking,background,unresolved,waiting,automatic,engine,connectionText};
}
