import {DEFAULTS,STRATEGY_DEFAULTS,VERSION,validateSettings,validateStrategy,isFunded} from './core.mjs';
import {paymentMarket} from './money.mjs';

const settingKeys=Object.keys(DEFAULTS).filter(k=>!['running','liveArmed'].includes(k));
const strategyKeys=[...Object.keys(STRATEGY_DEFAULTS),'payoutAddress','mergePayoutAddress'];
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]]));
const timestamp=(value,label)=>{if(value===null||value===undefined)return null;if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))throw new Error(label+' must be a valid timestamp');return new Date(value).toISOString();};
function checkTypes(value,defaults,keys){
  for(const k of keys)if(value[k]!==undefined&&typeof value[k]!==typeof defaults[k])throw new Error(k+' has an invalid type');
}

// A compact, portable configuration export. Full historical JSON exports remain
// valid inputs too; neither format grants permission to run or spend funds.
export function configurationBackup(state,now=new Date().toISOString()){
  return {kind:'fastpool-easymining-settings',schemaVersion:1,version:VERSION,exportedAt:now,
    settings:{...pick(state.settings,settingKeys),running:false,liveArmed:false},
    strategies:state.strategies.map(s=>pick(s,[...strategyKeys,'id']))};
}

export function parseConfigurationBackup(input){
  if(!record(input))throw new Error('Choose an EasyMining JSON export containing settings or strategies');
  if(input.kind==='fastpool-easymining-settings'&&input.schemaVersion!==1)throw new Error('This settings file uses an unsupported format version');
  const result={settings:null,strategies:null};
  if(Object.hasOwn(input,'settings')&&input.settings!==null){
    if(!record(input.settings)||!settingKeys.some(k=>Object.hasOwn(input.settings,k)))throw new Error('The export has no valid software settings');
    const values=pick(input.settings,settingKeys);checkTypes(values,DEFAULTS,settingKeys);
    result.settings={...validateSettings(values,DEFAULTS),running:false,liveArmed:false};
  }
  if(Object.hasOwn(input,'strategies')&&input.strategies!==null){
    if(!Array.isArray(input.strategies)||input.strategies.length>1000)throw new Error('Expected up to 1,000 strategies');
    const ids=new Set();
    result.strategies=input.strategies.map((raw,index)=>{
      try{
        if(!record(raw)||!Object.hasOwn(raw,'name'))throw new Error('Expected a strategy with a name');
        const values=pick(raw,strategyKeys);
        checkTypes(values,STRATEGY_DEFAULTS,strategyKeys.filter(k=>!['lastBuyAt','createdAt','payoutAddress','mergePayoutAddress'].includes(k)));
        for(const k of ['payoutAddress','mergePayoutAddress'])if(values[k]!==undefined&&typeof values[k]!=='string')throw new Error(k+' has an invalid type');
        const strategy=validateStrategy({...values,enabled:false});
        strategy.lastBuyAt=timestamp(raw.lastBuyAt,'lastBuyAt');
        strategy.createdAt=timestamp(raw.createdAt,'createdAt');
        if(raw.id!==undefined){
          if(typeof raw.id!=='string'||!raw.id.trim()||raw.id.length>160||/[\x00-\x1f\x7f]/.test(raw.id))throw new Error('Invalid strategy ID');
          if(ids.has(raw.id))throw new Error('Duplicate strategy ID');ids.add(raw.id);strategy.id=raw.id;
        }
        return strategy;
      }catch(error){throw new Error('Strategy '+(index+1)+': '+error.message);}
    });
  }
  if(!result.settings&&!result.strategies)throw new Error('Choose an EasyMining JSON export containing settings or strategies');
  return result;
}

export function prepareConfigurationImport(input,current,{restoreSettings=true,restoreStrategies=true,strategyMode='merge',paperOnly=false,idFactory,now=new Date().toISOString()}={}){
  if(typeof restoreSettings!=='boolean'||typeof restoreStrategies!=='boolean')throw new Error('Choose which configuration to restore');
  if(!['merge','replace'].includes(strategyMode))throw new Error('Choose a valid strategy import method');
  const backup=parseConfigurationBackup(input);
  if(!restoreSettings&&!restoreStrategies)throw new Error('Select settings or strategies to import');
  if(restoreSettings&&!backup.settings)throw new Error('This file has no software settings');
  if(restoreStrategies&&!backup.strategies)throw new Error('This file has no strategies');
  const settings={...(restoreSettings?backup.settings:current.settings),running:false,liveArmed:false};
  if(paperOnly)settings.mode='paper';
  let imported=[];
  if(restoreStrategies)imported=backup.strategies.map(s=>{
    const id=s.id||idFactory(),old=current.strategies.find(x=>x.id===id);
    if(old&&paymentMarket(old)!==paymentMarket(s)&&(current.orders||[]).some(o=>o.strategyId===id&&isFunded(o)))throw new Error('A strategy with funded purchases cannot change payment market. Create a separate strategy.');
    // Retain ledger links and the most recent observed buy. Re-importing a file
    // must not reset purchase counts, strategy budgets, or cooldowns.
    const times=[s.lastBuyAt,old?.lastBuyAt,...(current.orders||[]).filter(o=>o.strategyId===id&&isFunded(o)).map(o=>o.createdAt)].filter(x=>x&&Number.isFinite(Date.parse(x)));
    return {...s,id,enabled:false,createdAt:old?.createdAt||s.createdAt||now,lastBuyAt:times.length?new Date(Math.max(...times.map(x=>Date.parse(x)))).toISOString():null};
  });
  const importedIds=new Set(imported.map(s=>s.id));
  const strategies=restoreStrategies?[...(strategyMode==='merge'?current.strategies.filter(s=>!importedIds.has(s.id)):[]),...imported]:current.strategies;
  return {settings,strategies,importedCount:imported.length};
}
