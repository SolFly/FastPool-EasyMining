import http from 'node:http';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname,extname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID,scryptSync,timingSafeEqual,createHash} from 'node:crypto';
import {Store} from './store.mjs';
import {Engine} from './engine.mjs';
import {ManualPurchases} from './manual-purchases.mjs';
import {resolveUnboughtLevel} from './team-levels.mjs';
import {restoreConfiguration} from './config-backup.mjs';
import {configurationBackup} from '../public/config-backup.mjs';
import {fiatValue,rewardSummary} from '../public/rewards.mjs';
import {dailyProfits,dailyProfitCsvRows} from '../public/daily-profits.mjs';
import {purchaseDiagnostics} from '../public/purchase-diagnostics.mjs';
import {loadServerConfig,normalizeCredentials} from './config.mjs';
import {errorResponse} from './http-errors.mjs';
import {validateSettings,validateStrategy,VERSION,decimal,units,isCurrent,isAccounted,attributionHeld,spendEntries} from '../public/core.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const serverConfig=loadServerConfig({root});
const store=new Store(resolve(process.env.DATA_DIR||join(root,'data')));
if(!store.get('credentialSource'))store.set('credentialSource',store.get('credentials')?'web':serverConfig.credentials?'server':'none');
const credentials=()=>store.get('credentialSource')==='server'?serverConfig.credentials:store.get('credentialSource')==='none'?null:store.credentials();
const engine=new Engine(store,{credentials});
engine.repairRejectedAttempts();
engine.prepareAttributionAudit();
const purchases=new ManualPurchases(engine);
// Server environment/file values can change between restarts without a UI save.
store.set('verified',false);
function connectionInfo(){const c=credentials();return {configured:!!c,verified:!!c&&!!store.get('verified'),organizationId:c?.orgId||'',baseUrl:c?.baseUrl||'https://api2.nicehash.com',
  source:store.get('credentialSource'),serverAvailable:!!serverConfig.credentials,serverSource:serverConfig.source,serverConfigError:serverConfig.error};}
function appState(){return {...store.state(),connection:connectionInfo()};}
const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||8080);
let setupToken=store.get('admin')?null:randomBytes(24).toString('hex');
const loginAttempts=new Map();
function passwordHash(password,salt=randomBytes(16).toString('hex')){return {salt,hash:scryptSync(password,salt,64).toString('hex')};}
function checkPassword(password){const a=store.get('admin');if(!a||typeof password!=='string')return false;return timingSafeEqual(Buffer.from(a.hash,'hex'),scryptSync(password,a.salt,64));}
if(!store.get('admin')&&process.env.APP_PASSWORD){if(process.env.APP_PASSWORD.length<12)throw new Error('APP_PASSWORD must have at least 12 characters');store.set('admin',passwordHash(process.env.APP_PASSWORD));setupToken=null;}
const cookieHash=token=>createHash('sha256').update(token).digest('hex');
function authorized(req){const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('fp_session='))?.slice(11);return !!(token&&store.db.prepare('SELECT token FROM sessions WHERE token=? AND expires>?').get(cookieHash(token),Date.now()));}
function send(res,status,data,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(typeof data==='string'?data:JSON.stringify(data));}
async function body(req,limit=524288){const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>limit)throw Object.assign(new Error('Request is too large'),{status:413});chunks.push(c);}try{const text=Buffer.concat(chunks).toString('utf8');return text?JSON.parse(text):{};}catch{throw Object.assign(new Error('Invalid JSON'),{status:400});}}
function session(res,req){const token=randomBytes(32).toString('hex');store.db.prepare('INSERT INTO sessions(token,expires) VALUES (?,?)').run(cookieHash(token),Date.now()+12*3600000);const secure=process.env.PUBLIC_URL?.startsWith('https:')||req.socket.encrypted;res.setHeader('Set-Cookie','fp_session='+token+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200'+(secure?'; Secure':''));}
const csvCell=v=>{let x=String(v??'');if(/^[\s]*[=+@-]/.test(x))x="'"+x;return '"'+x.replaceAll('"','""')+'"';};
const csv=rows=>rows.map(r=>r.map(csvCell).join(',')).join('\r\n');
async function api(req,res,url){
  const path=url.pathname,method=req.method;
  if(method!=='GET'){
    const expected=process.env.PUBLIC_URL?new URL(process.env.PUBLIC_URL).origin:'http://'+req.headers.host;
    if(req.headers.origin!==expected||req.headers['sec-fetch-site']==='cross-site')return send(res,403,{error:'Same-origin request required'});
  }
  if(path==='/api/auth/status')return send(res,200,{setup:!store.get('admin'),authenticated:authorized(req),version:VERSION});
  if(path==='/api/auth/setup'&&method==='POST'){
    const b=await body(req);
    if(store.get('admin'))return send(res,409,{error:'Account is already configured'});
    if(typeof b.token!=='string'||b.token!==setupToken)return send(res,403,{error:'Incorrect setup token; find it in the server console'});
    if(typeof b.password!=='string'||b.password.length<12)return send(res,400,{error:'Use a password with at least 12 characters'});
    store.set('admin',passwordHash(b.password));setupToken=null;session(res,req);return send(res,200,{ok:true});
  }
  if(path==='/api/auth/login'&&method==='POST'){
    const ip=req.socket.remoteAddress,b=await body(req),a=loginAttempts.get(ip)||{count:0,until:Date.now()+900000};
    if(Date.now()>a.until){a.count=0;a.until=Date.now()+900000;}
    if(a.count>=10)return send(res,429,{error:'Too many login attempts. Try again in 15 minutes.'});
    if(!checkPassword(b.password)){a.count++;loginAttempts.set(ip,a);return send(res,401,{error:'Incorrect password'});}
    loginAttempts.delete(ip);session(res,req);return send(res,200,{ok:true});
  }
  if(!authorized(req))return send(res,401,{error:'Sign in to continue',code:'AUTH_REQUIRED'});
  if(path==='/api/state'&&method==='GET')return send(res,200,appState());
  if(path==='/api/payout-addresses'&&method==='GET')return send(res,200,{addresses:await engine.client().payoutAddresses(url.searchParams.get('currency')||'')});
  if(path==='/api/rates'&&method==='POST')return send(res,200,{rates:await engine.refreshRates({force:true}),error:store.get('runtime')?.ratesError||null});
  if(path==='/api/purchases/quote'&&method==='POST')return send(res,200,await purchases.quote(await body(req)));
  if(path==='/api/purchases'&&method==='POST'){const b=await body(req);return send(res,200,await purchases.buy(b.quoteId,{twofaToken:b.twofaToken||''}));}
  if(path==='/api/auth/logout'&&method==='POST'){
    const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('fp_session='))?.slice(11);
    if(token)store.db.prepare('DELETE FROM sessions WHERE token=?').run(cookieHash(token));
    res.setHeader('Set-Cookie','fp_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return send(res,200,{ok:true});
  }
  if(path==='/api/settings'&&method==='POST'){
    const b=await body(req),old=store.get('settings'),s=validateSettings(b,old);
    if(engine.busy)return send(res,409,{error:'An evaluation is in progress. Pause the engine and retry after it completes.'});
    // Mode changes always require a separate live-arm action.
    if(s.mode!==old.mode){s.running=false;s.liveArmed=false;}
    if(s.mode==='live'&&s.running&&(!s.liveArmed||!store.get('verified')))return send(res,400,{error:'Verify the connection and arm live buying first'});
    store.set('settings',s);store.event('info','Settings updated');return send(res,200,{ok:true});
  }
  if(path==='/api/arm'&&method==='POST'){
    const b=await body(req);if(b.confirm!=='ENABLE LIVE BUYING'||!checkPassword(b.password))return send(res,400,{error:'Enter your admin password and type ENABLE LIVE BUYING'});
    if(!store.get('verified'))return send(res,400,{error:'Test and sync the API connection first'});
    if(engine.busy)return send(res,409,{error:'Wait for the current evaluation to complete'});
    engine.pause('Preparing live buying');await engine.syncNow();
    if(store.get('runtime')?.historyComplete===false){
      const r=store.get('runtime'),warnings=r.syncWarnings||[];
      const details=warnings.slice(0,3).map(w=>(w.teamId?'Team '+w.teamId+': ':w.orderId?'Order '+w.orderId+': ':'')+w.reason).join(' ');
      const retry=store.get('settings').autoSync!==false?' Account sync will retry automatically.':' Use Test & sync to check again.';
      return send(res,409,{error:'Balance verified; history is still incomplete. '+(details||'Account ownership checks are still running.')+retry,code:'HISTORY_INCOMPLETE',warnings,warningCount:r.syncWarningCount||warnings.length,nextSyncAt:r.nextSyncAt});
    }
    if(store.orders().some(o=>o.mode==='live'&&['UNKNOWN','SUBMITTING'].includes(o.status)))return send(res,400,{error:'Reconcile unresolved orders first'});
    const s=store.get('settings');s.mode='live';s.liveArmed=true;s.running=false;store.set('settings',s);store.event('warning','Live buying armed by administrator');return send(res,200,{ok:true});
  }
  if(path==='/api/pause'&&method==='POST'){engine.pause('Paused by administrator');return send(res,200,{ok:true});}
  if(path==='/api/strategies'&&method==='POST'){
    const b=await body(req),old=store.strategies().find(s=>s.id===b.id),s=validateStrategy(b,old);
    s.id=old?.id||randomUUID();s.createdAt=old?.createdAt||new Date().toISOString();store.strategy(s);store.event('info','Strategy saved: '+s.name);return send(res,200,{ok:true,id:s.id});
  }
  if(path.startsWith('/api/strategies/')&&method==='DELETE'){
    store.db.prepare('DELETE FROM strategies WHERE id=?').run(path.split('/').at(-1));return send(res,200,{ok:true});
  }
  if(path==='/api/connection'&&method==='POST'){
    const b=await body(req),raw=b.nicehash||b,old=credentials()||{},c=normalizeCredentials({
      orgId:raw.organization_id||raw.orgId||old.orgId,key:raw.api_key||raw.key||old.key,secret:raw.api_secret||raw.secret||old.secret,
      baseUrl:raw.base_url||raw.baseUrl||old.baseUrl});
    if(engine.busy)return send(res,409,{error:'Wait for the current evaluation before changing account credentials'});
    if(store.get('ledgerOrgId')&&String(store.get('ledgerOrgId')).toLowerCase()!==c.orgId.toLowerCase()&&store.orders().some(o=>o.mode==='live'))throw new Error('This ledger belongs to another organization. Run a separate instance for another account.');
    store.saveCredentials(c);store.set('credentialSource','web');store.set('organizationId',c.orgId);store.set('verified',false);engine.api=null;engine.pause('Connection updated');return send(res,200,{ok:true});
  }
  if(path==='/api/connection/server'&&method==='POST'){
    if(engine.busy)return send(res,409,{error:'Wait for the current evaluation before changing credentials'});
    if(!serverConfig.credentials)throw new Error(serverConfig.error||'No complete NiceHash server environment/configuration is available');
    if(store.get('ledgerOrgId')&&String(store.get('ledgerOrgId')).toLowerCase()!==serverConfig.credentials.orgId.toLowerCase()&&store.orders().some(o=>o.mode==='live'))throw new Error('This ledger belongs to another organization. Run a separate instance for another account.');
    store.set('credentialSource','server');store.set('organizationId',serverConfig.credentials.orgId);store.set('verified',false);engine.api=null;engine.pause('Using server NiceHash configuration');return send(res,200,{ok:true});
  }
  if(path==='/api/connection'&&method==='DELETE'){
    if(engine.busy)return send(res,409,{error:'Wait for the current evaluation before disconnecting'});
    engine.pause('Connection disconnected');store.db.prepare("DELETE FROM kv WHERE key IN ('credentials','organizationId','verified')").run();store.set('credentialSource','none');engine.api=null;return send(res,200,{ok:true});
  }
  if(path==='/api/sync'&&method==='POST'){
    if(engine.busy)return send(res,409,{error:'Engine is busy; try again after this cycle'});
    const r=await engine.syncNow();store.event(r.historyComplete?'info':'warning',r.historyComplete?'NiceHash history and balances synchronized':'Account history is still updating; automatic sync will retry');return send(res,200,r);
  }
  if(path==='/api/tick'&&method==='POST')return send(res,200,await engine.tick({manual:true}));
  if(path==='/api/reconcile'&&method==='POST'){
    const b=await body(req),o=store.orders().find(o=>o.id===b.id);
    if(engine.busy)return send(res,409,{error:'Wait for the current evaluation before reconciling'});
    if(!o||!['UNKNOWN','SUBMITTING'].includes(o.status))throw new Error('Order does not need reconciliation');
    engine.pause('Purchase reconciliation');
    if(o.pendingTeamPurchase&&b.confirm==='VERIFIED NO ADDITION'){
      if(!checkPassword(b.password)||String(b.note||'').trim().length<10)throw new Error('Provide your password and a source note verifying the last addition was not charged');
      resolveUnboughtLevel(o,b.note);store.saveOrder(o);store.event('warning','Last team addition reconciled as not purchased; previous commitment retained: '+o.id);return send(res,200,{ok:true});
    }
    if(o.pendingTeamPurchase&&b.confirm==='VERIFIED NO PURCHASE')throw new Error('This team contains earlier purchases. Verify only the last addition with VERIFIED NO ADDITION.');
    if(b.externalId){const raw=await engine.client().ticket(b.externalId,o.kind==='team');
      if(o.kind==='team'&&raw.id!==o.packageId)throw new Error('This is a different team package');
      const imported=o.kind==='team'?engine.importTeam(raw,store.get('runtime')?.rates||{}):await engine.importSolo(raw);
      if(!imported)throw new Error('That team response still does not identify your organization. Keep the purchase reserved until its membership or final debit is verified.');
      if(imported.id!==o.id){
        const original=imported.id;
        for(const r of store.rewards().filter(r=>r.orderId===original)){r.orderId=o.id;store.reward(r);}
        store.db.prepare('DELETE FROM orders WHERE id=?').run(original);
        store.saveOrder({...o,...imported,id:o.id,strategyId:o.strategyId,requestId:o.requestId,createdAt:o.createdAt});
      }
    }else if(b.action==='final-debit'){
      if(!checkPassword(b.password)||String(b.note||'').trim().length<10)throw new Error('Provide your password and a source note for the verified final debit/refund');
      if(!Number.isSafeInteger(b.costBtc)||b.costBtc<0||!Number.isSafeInteger(b.refundBtc)||b.refundBtc<0||b.refundBtc>b.costBtc)throw new Error('Provide valid original cost and verified refund amounts');
      if(o.pendingTeamPurchase&&b.costBtc<(o.pendingTeamPurchase.before?.costBtc||0))throw new Error('The total cost cannot discard earlier verified team purchases');
      const pending=o.pendingTeamPurchase,previousTotal=o.costBtc+(o.feeBtc||0)-(o.refundBtc||0),previousHistory=spendEntries(o);
      o.accountingOverride={at:new Date().toISOString(),note:b.note,values:{costBtc:b.costBtc,refundBtc:b.refundBtc,feeBtc:0,status:'COMPLETED'}};
      Object.assign(o,o.accountingOverride.values);o.accountingNote='Manually reconciled: '+b.note;
      if(pending){const entry=o.teamBuys?.find(e=>e.requestId===pending.requestId);if(entry){entry.status='MANUALLY_VERIFIED';entry.resolution=b.note;}delete o.pendingTeamPurchase;delete o.syncPending;delete o.error;
        o.spendHistory=[...previousHistory,{at:o.accountingOverride.at,amountBtc:o.costBtc-o.refundBtc-previousTotal,note:'Manually verified final team commitment/refund'}];}
      store.saveOrder(o);
    }else{
      if(b.confirm!=='VERIFIED NO PURCHASE'||!checkPassword(b.password))throw new Error('Verify the purchase was not charged, then enter your password and confirmation phrase');
      if(String(b.note||'').trim().length<10)throw new Error('Add a reconciliation note');
      o.status='FAILED';o.resolution=b.note;o.feeBtc=0;store.saveOrder(o);
    }
    store.event('warning','Purchase reconciled by administrator: '+o.id);return send(res,200,{ok:true});
  }
  if(path==='/api/reward-confirmation'&&method==='POST'){
    const b=await body(req),r=store.rewards().find(r=>r.id===b.id);
    if(engine.busy)return send(res,409,{error:'Wait for the current evaluation before reconciling rewards'});
    if(!r||r.confirmed)throw new Error('Reward is already confirmed or does not exist');
    if(!checkPassword(b.password)||String(b.note||'').trim().length<10)throw new Error('Provide your password and the verified payout transaction/source');
    r.confirmed=true;r.confirmedAt=new Date().toISOString();r.manualConfirmed={at:r.confirmedAt,note:b.note};store.reward(r);
    store.event('warning','Payout manually confirmed by administrator: '+r.id+' · '+b.note);return send(res,200,{ok:true});
  }
  if(path==='/api/reward-value'&&method==='POST'){
    const b=await body(req),r=store.rewards().find(r=>r.id===b.id);
    if(!r||Number.isSafeInteger(r.valueBtc))throw new Error('Reward does not need valuation');
    if(!Number.isSafeInteger(b.valueBtc)||b.valueBtc<0||String(b.note||'').length<10)throw new Error('Provide BTC value and a source note');
    r.valueBtc=b.valueBtc;r.valuation='Manual valuation: '+b.note;store.reward(r);store.event('warning','Manual reward valuation: '+r.id);return send(res,200,{ok:true});
  }
  if(path==='/api/export'&&method==='GET'){
    const state=store.state();
    if(url.searchParams.get('format')==='purchase-diagnostics')return send(res,200,purchaseDiagnostics(state,connectionInfo()),{'Content-Disposition':'attachment; filename="easymining-purchase-diagnostics.json"'});
    if(url.searchParams.get('format')==='settings')return send(res,200,configurationBackup(state),{'Content-Disposition':'attachment; filename="easymining-settings.json"'});
    if(url.searchParams.get('format')==='daily-csv'){
      const mode=url.searchParams.get('mode')||state.settings.mode;
      if(!['paper','live'].includes(mode))throw new Error('Invalid reporting mode');
      const rates=state.runtime.exchangeRates,report=dailyProfits(state.orders,state.rewards,{mode,timezone:state.settings.timezone,days:Number(url.searchParams.get('days')??30),rates});
      return send(res,200,csv(dailyProfitCsvRows(report,rates)),{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="easymining-daily-'+mode+'.csv"'});
    }
    if(url.searchParams.get('format')==='csv'){
      const mode=url.searchParams.get('mode')||state.settings.mode;
      const rates=state.runtime.exchangeRates,toFiat=(amount,coin,currency)=>{const n=fiatValue(amount,coin,currency,rates);return n===null?'UNPRICED':n.toFixed(2);};
      const rows=[['Order ID','NiceHash ID','Mode','Package','Coin','Status','Created','Cost BTC','Reserved fee BTC','Refund BTC','Source','Payout address','Merged reward coin','Merged payout address','Package type','My shares','Total team shares','My team share percent']];
      for(const o of state.orders.filter(o=>isAccounted(o)&&o.mode===mode))rows.push([o.id,o.externalId,o.mode,o.name,o.coin,o.status,o.createdAt,decimal(o.costBtc),decimal(o.feeBtc||0),decimal(o.refundBtc||0),o.source,o.payoutAddress||'',o.mergeCoin||'',o.mergePayoutAddress||'',o.kind,o.shares,o.rewardEstimate?.totalShares??'',o.kind==='team'&&Number.isFinite(o.rewardEstimate?.fraction)?(o.rewardEstimate.fraction*100).toFixed(8):'']);
      const levelOrders=state.orders.filter(o=>isAccounted(o)&&o.mode===mode&&o.teamBuys?.length);
      if(levelOrders.length){rows.push([],['Team buying level audit (already included in order totals)','Order ID','Threshold joined shares','Additional shares','Requested addition BTC','Status','Request ID','Timestamp']);
        for(const o of levelOrders)for(const entry of o.teamBuys)rows.push(['Level attempt',o.id,entry.threshold,entry.shares,decimal(entry.amountBtc),entry.status,entry.requestId||'',entry.createdAt]);}
      rows.push([],['Reward ID','Order ID','Coin','Amount','Confirmed','BTC accounting equivalent','Valuation source','Block/reward timestamp','First observed confirmation','Current USD estimate','Current EUR estimate','Spot rate timestamp']);
      for(const r of state.rewards.filter(r=>!r.supersededBy&&state.orders.some(o=>isAccounted(o)&&o.id===r.orderId&&o.mode===mode)))rows.push([r.id,r.orderId,r.coin,decimal(r.amount),r.confirmed,Number.isSafeInteger(r.valueBtc)?decimal(r.valueBtc):'UNPRICED',r.valuation,r.createdAt,r.confirmedAt||'',toFiat(r.amount,r.coin,'USD'),toFiat(r.amount,r.coin,'EUR'),rates?.at||'']);
      rows.push([],['Coin totals (all time)','Confirmed amount','Pending amount','Confirmed current USD estimate','Confirmed current EUR estimate','Spot rate timestamp']);
      for(const r of rewardSummary(state.orders,state.rewards,{mode},rates))rows.push([r.coin,decimal(r.confirmed),decimal(r.pending),r.usd===null?'UNPRICED':r.usd.toFixed(2),r.eur===null?'UNPRICED':r.eur.toFixed(2),rates?.at||'']);
      const held=state.orders.filter(o=>isCurrent(o)&&o.mode===mode&&attributionHeld(o));
      if(held.length){rows.push([],['Excluded from financial report: ownership verification pending','Reason']);for(const o of held)rows.push([o.externalId||o.id,o.attribution.reason]);}
      return send(res,200,csv(rows),{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="easymining-ledger.csv"'});
    }
    delete state.connection;state.settings.running=false;state.settings.liveArmed=false;
    return send(res,200,{version:VERSION,exportedAt:new Date().toISOString(),...state},{'Content-Disposition':'attachment; filename="easymining-backup.json"'});
  }
  if(path==='/api/import'&&method==='POST'){
    const b=await body(req,2*1024*1024);return send(res,200,restoreConfiguration(engine,b.backup,b.options));
  }
  if(path==='/api/import-strategies'&&method==='POST'){
    const b=await body(req);if(!Array.isArray(b.strategies)||b.strategies.length>100)throw new Error('Expected a backup with up to 100 strategies');
    const clean=b.strategies.map(s=>({...validateStrategy({...s,enabled:false}),id:randomUUID(),lastBuyAt:null}));
    for(const s of clean)store.strategy(s);store.event('info','Imported '+clean.length+' paused strategies');return send(res,200,{ok:true});
  }
  if(path==='/api/password'&&method==='POST'){
    const b=await body(req);if(!checkPassword(b.current)||typeof b.password!=='string'||b.password.length<12)throw new Error('Enter current password and a new password with at least 12 characters');
    store.set('admin',passwordHash(b.password));store.db.prepare('DELETE FROM sessions').run();session(res,req);return send(res,200,{ok:true});
  }
  return send(res,404,{error:'Unknown endpoint'});
}
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.startsWith('/api/'))return await api(req,res,url);
    if(req.method!=='GET'&&req.method!=='HEAD')return send(res,405,{error:'Method not allowed'});
    if(url.pathname==='/healthz')return send(res,200,{ok:true,version:VERSION});
    if(url.pathname==='/config.js'){res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'});return res.end('window.FP_DEMO = false;');}
    const name=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname),file=resolve(root,'public','.'+name);
    if(!file.startsWith(join(root,'public')+'/')||!existsSync(file))return send(res,404,{error:'File not found'});
    const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.zip':'application/zip','.json':'application/json'};
    res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-cache',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(readFileSync(file));
  }catch(e){if(!res.headersSent){const mapped=errorResponse(e);send(res,mapped.status,mapped.body);}else res.end();}
});
const timer=setInterval(()=>{engine.background().catch(()=>{});},5000);timer.unref();
server.listen(port,host,()=>{
  console.log('FastPool EasyMining '+VERSION+' · http://'+host+':'+server.address().port);
  if(setupToken)console.log('ONE-TIME SETUP TOKEN: '+setupToken);
  console.log('Engine starts paused. Configure settings in the web UI.');
  engine.refreshPackages().catch(e=>store.event('warning','Catalogue refresh: '+e.message));
});
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{clearInterval(timer);engine.pause('Server shutdown');server.close(()=>{store.close();process.exit(0);});});
