import {randomUUID} from 'node:crypto';
import {prepareConfigurationImport} from '../public/config-backup.mjs';

export function restoreConfiguration(engine,backup,options={}){
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('Choose valid import options');
  options={restoreSettings:options.restoreSettings??true,restoreStrategies:options.restoreStrategies??true,strategyMode:options.strategyMode??'merge'};
  const store=engine.store,owner=randomUUID();
  if(engine.busy||!store.acquire(owner))throw Object.assign(new Error('A purchase or sync is in progress. Wait for it to finish, then retry the import.'),{status:409});
  engine.busy=true;
  try{
    const plan=prepareConfigurationImport(backup,{settings:store.get('settings'),strategies:store.strategies(),orders:store.orders()},{...options,idFactory:randomUUID});
    store.db.exec('BEGIN IMMEDIATE');
    try{
      store.set('settings',plan.settings);
      if(options.restoreStrategies!==false){
        store.db.prepare('DELETE FROM strategies').run();
        for(const strategy of plan.strategies)store.strategy(strategy);
      }
      // Completed review links remain for idempotent replay/audit. Only unused
      // reviews expire when the configuration changes.
      store.db.prepare("DELETE FROM kv WHERE key LIKE 'purchase-quote:%' AND json_extract(value,'$.orderId') IS NULL").run();
      store.event('warning','Configuration imported: '+(options.restoreSettings!==false?'software settings; ':'')+plan.importedCount+' paused strategies. Engine paused and live buying disarmed.');
      store.db.exec('COMMIT');
    }catch(error){store.db.exec('ROLLBACK');throw error;}
    return {ok:true,importedStrategies:plan.importedCount,settingsRestored:options.restoreSettings!==false};
  }finally{engine.busy=false;store.release(owner);}
}
