import {telegramDemoReport} from './telegram.mjs';
import {paymentMarket,money,fundingRecord} from './money.mjs';
import {DEFAULTS,STRATEGY_DEFAULTS,units,normalizePackage,validateStrategy,validateSettings,guard,pickQuote} from './core.mjs';
import {manualQuote,manualStrategy} from './purchases.mjs';
import {normalizeRates} from './rewards.mjs';
import {prepareConfigurationImport} from './config-backup.mjs';
import {purchaseRewardEstimate} from './package-rewards.mjs';
const KEY='fp-easymining-demo-v1';
const stamp=()=>new Date().toISOString();
const id=()=>typeof crypto.randomUUID==='function'?crypto.randomUUID():Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
const demoRates=()=>normalizeRates({list:[['USDT','USD',1],['USDT','EUR',88000/95000],['BTC','USD',95000],['BTC','EUR',88000],['BCH','USD',500],['BCH','EUR',463],['LTC','USD',80],['LTC','EUR',74],['DOGE','USD',.12],['DOGE','EUR',.11],['ZEC','USD',50],['ZEC','EUR',46]].map(([fromCurrency,toCurrency,exchangeRate])=>({fromCurrency,toCurrency,exchangeRate}))});
export async function createDemo(){
  const snap=await (await fetch('/catalogue-snapshot.json')).json(),now=Date.now();
  const packages=[...snap.solo.map(p=>normalizePackage(p,stamp())),...snap.teams.map(p=>normalizePackage(p,stamp(),true))];
  for(const p of packages.filter(p=>p.team)){p.teamShares=Math.max(68,p.teamShares);p.teamCommitted=p.teamShares*p.minShare;}
  const settings={...DEFAULTS,usdtLimits:{dailyCap:units('50'),weeklyCap:units('200'),monthlyCap:units('600'),maxOrder:units('25'),reserve:0,stopLoss:0,takeProfit:0,paperBalance:units('100')},dailyCap:units('0.003'),weeklyCap:units('0.015'),monthlyCap:units('0.04'),maxOrder:units('0.0011'),
    paperBalance:units('0.05'),stopLoss:units('0.02'),running:true};
  const strategies=[
    {...STRATEGY_DEFAULTS,id:'demo-team',name:'Team Gold · patient entry',mode:'team',kind:'team',packageName:'Team Gold',minTeamShares:50,budget:units('0.004'),maxPrice:units('0.0001'),maxPurchases:40,enabled:true},
    {...STRATEGY_DEFAULTS,id:'demo-silver',name:'Silver M · price ceiling',mode:'solo',kind:'price',coin:'BCH',packageName:'Silver M',maxPrice:units('0.001'),budget:units('0.012'),maxPurchases:12,intervalMinutes:360,enabled:true},
    {...STRATEGY_DEFAULTS,id:'demo-bronze',name:'Bronze S · better odds',mode:'solo',kind:'odds',coin:'ZEC',packageName:'Bronze S',maxOdds:300,budget:units('0.004'),maxPurchases:40,enabled:false}
  ];
  const orders=[];
  for(let i=0;i<45;i++){
    const s=strategies[i%3],large=s.id==='demo-silver'&&i%9===1;
    const when=now-((44-i)*.65+.3)*86400000;
    orders.push({id:'demo-order-'+i,requestId:id(),mode:'paper',kind:s.mode,strategyId:s.id,packageId:'demo-package-'+i,
      name:s.id==='demo-team'?'Team Gold':s.id==='demo-silver'?(large?'Silver M':'Silver S'):'Bronze S',coin:s.coin,
      shares:1,costBtc:large?100000:10000,feeBtc:0,refundBtc:0,createdAt:new Date(when).toISOString(),
      endAt:new Date(when+14400000).toISOString(),status:i>=43?'ACTIVE':'COMPLETED',source:'Illustrative sample',odds:s.id==='demo-team'?120:s.id==='demo-silver'?122:285});
  }
  const rewards=[
    {id:'demo-reward-1',orderId:'demo-order-12',coin:'BTC',amount:310000,confirmed:true,valueBtc:310000,createdAt:orders[12].endAt,valuation:'Illustrative sample reward'},
    {id:'demo-reward-2',orderId:'demo-order-28',coin:'BCH',amount:312500000,confirmed:true,valueBtc:170000,createdAt:orders[28].endAt,valuation:'Illustrative BTC equivalent'},
    {id:'demo-reward-3',orderId:'demo-order-44',coin:'ZEC',amount:156250000,confirmed:false,valueBtc:85000,createdAt:new Date(now-3600000).toISOString(),confirmations:37,minConfirmations:100,valuation:'Illustrative pending reward'}
  ];
  const events=[
    ['info','Paper cycle evaluated · all spending limits checked',1],
    ['info','Team Gold threshold met · 68 shares in the sample team',9],
    ['info','Bronze S reward awaiting confirmations · 37 / 100',22],
    ['warning','Silver M waiting for its 6-hour buying interval',36],
    ['info','Sample package catalogue loaded',52]
  ].map(([level,message,minutes],i)=>({id:i,at:new Date(now-minutes*60000).toISOString(),level,message}));
  const usdtTeam=packages.find(p=>p.market==='USDT'&&p.team),usdtSolo=packages.find(p=>p.market==='USDT'&&!p.team);
  if(usdtTeam)strategies.push({...STRATEGY_DEFAULTS,id:'demo-usdt',name:'USDT · continuous team buying',market:'USDT',coin:usdtTeam.coin,packageName:usdtTeam.name,mode:'team',kind:'team',minTeamShares:20,maxPrice:units('5'),budget:units('100'),continuous:true,enabled:false});
  if(usdtSolo){
    const when=new Date(now-3600000).toISOString();
    orders.push(fundingRecord('USDT',{id:'demo-usdt-order',mode:'paper',kind:'solo',strategyId:null,packageId:usdtSolo.id,name:usdtSolo.name,coin:usdtSolo.coin,shares:1,costBtc:units('5'),feeBtc:0,refundBtc:0,createdAt:when,endAt:when,status:'COMPLETED',source:'Illustrative USDT sample'}));
    rewards.push({id:'demo-usdt-reward',orderId:'demo-usdt-order',coin:'BCH',amount:units('0.0125'),confirmed:true,valueBtc:6579,valueUsdt:units('6.25'),createdAt:when,confirmedAt:when,valuation:'Illustrative BTC estimate',usdtValuation:'Illustrative USDT value'});
  }
  return {demo:true,demoVersion:'2.1.0',settings,strategies,orders:orders.reverse(),rewards,packages,events,
    runtime:{lastTick:stamp(),lastSync:null,errors:0,catalogueSnapshot:snap.capturedAt,rates:{BTC:1},exchangeRates:demoRates(),decisions:[]},connection:{configured:false,verified:false,organizationId:''}};
}
export class DemoApi {
  constructor(state){this.state=state;}
  static async open(){
    let s;try{s=JSON.parse(localStorage.getItem(KEY));}catch{}if(!s?.demo)s=await createDemo();
    if(s.demoVersion!=='2.1.0'){
      const fresh=await createDemo();s.packages=fresh.packages;s.runtime.exchangeRates=fresh.runtime.exchangeRates;s.runtime.catalogueSnapshot=fresh.runtime.catalogueSnapshot;
      s.settings.usdtLimits||=fresh.settings.usdtLimits;
      if(!s.orders.some(o=>paymentMarket(o)==='USDT')){s.orders.push(...fresh.orders.filter(o=>paymentMarket(o)==='USDT'));s.rewards.push(...fresh.rewards.filter(r=>r.id==='demo-usdt-reward'));}
      if(!s.strategies.some(st=>paymentMarket(st)==='USDT'))s.strategies.push(...fresh.strategies.filter(st=>paymentMarket(st)==='USDT'));
      for(const st of s.strategies){if(st.continuous===undefined){st.continuous=true;st.stopOnWin=false;}st.market||='BTC';}
      s.runtime.decisions=[];s.demoVersion='2.1.0';
    }
    return new DemoApi(s);
  }
  persist(){localStorage.setItem(KEY,JSON.stringify(this.state));}
  event(message,level='info'){this.state.events.unshift({id:id(),at:stamp(),level,message});this.state.events=this.state.events.slice(0,300);}
  async request(path,method='GET',body={}){
    const s=this.state;
    if(path==='/api/telegram/report'&&method==='GET')return telegramDemoReport(s);
    if(path.startsWith('/api/telegram'))throw new Error('Configure Telegram in your self-hosted application. This preview does not accept bot credentials or send messages.');
    if(path==='/api/auth/status')return {authenticated:true,setup:false};
    if(path==='/api/state')return structuredClone(s);
    if(path==='/api/payout-addresses')return {addresses:[{id:'demo-btc',currency:'BTC',name:'Illustrative BTC destination',address:'bc1qexampledemodestination000000000000000000'},{id:'demo-ltc',currency:'LTC',name:'Illustrative LTC destination',address:'ltc1qexampledemodestination0000000000000000'},{id:'demo-doge',currency:'DOGE',name:'Illustrative DOGE destination',address:'DExampleDemoDestination0000000000000'}]};
    if(path==='/api/purchases/quote'){
      s.packages.forEach(p=>p.quotedAt=stamp());const q=manualQuote(s.packages,body,s.settings);
      s.purchaseReviews||={};s.purchaseReviews[q.id]=q;this.persist();return structuredClone(q);
    }
    if(path==='/api/purchases'){
      const q=s.purchaseReviews?.[body.quoteId];if(!q)throw new Error('Review the package first');
      if(q.orderId)return {order:s.orders.find(o=>o.id===q.orderId),replayed:true};
      if(Date.now()>Date.parse(q.expiresAt))throw new Error('Purchase review expired. Review the package again.');
      if(s.settings.mode!=='paper')throw new Error('The hosted preview supports paper purchases only');
      const p=s.packages.find(p=>p.id===q.packageId),quote=fundingRecord(paymentMarket(p),{...p,costBtc:money(p,'costBtc')*q.shares,quotedAt:stamp()}),reason=guard(s,manualStrategy(q),quote,Date.now(),{manual:true});
      if(reason)throw new Error(reason);
      const order=fundingRecord(paymentMarket(q),{id:id(),requestId:q.id,mode:'paper',kind:q.team?'team':'solo',strategyId:null,packageId:q.packageId,name:q.name,coin:q.coin,mergeCoin:q.mergeCoin,shares:q.shares,
        payoutAddress:q.payoutAddress,mergePayoutAddress:q.mergePayoutAddress,rewardEstimate:purchaseRewardEstimate(p,q.shares),costBtc:money(quote,'costBtc'),feeBtc:0,refundBtc:0,status:'ACTIVE',createdAt:stamp(),endAt:new Date(Date.now()+p.duration*1000).toISOString(),source:'Manual paper purchase'});
      s.orders.unshift(order);q.orderId=order.id;this.event('Manual paper purchase: '+q.name+' · '+q.shares+' unit(s)');this.persist();return {order,replayed:false};
    }
    if(path==='/api/rates'){s.runtime.exchangeRates=demoRates();this.persist();return {rates:s.runtime.exchangeRates};}
    if(path==='/api/settings'){const next=validateSettings(body,s.settings);if(next.mode==='live')throw new Error('Use the self-hosted application to connect NiceHash and enable live buying');s.settings=next;this.event('Paper settings updated');}
    else if(path==='/api/pause'){s.settings.running=false;this.event('Paper engine paused','warning');}
    else if(path==='/api/strategies'&&method==='POST'){
      const old=s.strategies.find(x=>x.id===body.id),strategy=validateStrategy(body,old);strategy.id=old?.id||id();
      if(old&&paymentMarket(old)!==paymentMarket(strategy)&&s.orders.some(o=>o.strategyId===old.id&&!['FAILED','REJECTED','SUPERSEDED'].includes(o.status)))throw new Error('Create a separate strategy to change payment market after a purchase.');
      s.strategies=old?s.strategies.map(x=>x.id===old.id?strategy:x):[...s.strategies,strategy];this.event('Strategy saved: '+strategy.name);
    }else if(path.startsWith('/api/strategies/')&&method==='DELETE'){s.strategies=s.strategies.filter(x=>x.id!==path.split('/').at(-1));this.event('Strategy deleted');}
    else if(path==='/api/tick'){
      s.packages.forEach(p=>p.quotedAt=stamp());const decisions=[];
      for(const strategy of s.strategies){const q=pickQuote(s.packages,strategy,s.orders.filter(o=>o.mode===s.settings.mode)),reason=guard(s,strategy,q);decisions.push({id:strategy.id,name:strategy.name,reason:reason||'Paper purchase created'});
        if(!reason){
          if(q.teamLevel){
            let order=s.orders.find(o=>o.id===q.parentOrderId);const when=stamp();
            if(order){
              if(!order.teamBuys?.length)order.teamBuys=[fundingRecord(paymentMarket(order),{threshold:strategy.teamLevels[0].threshold,shares:order.shares,amountBtc:money(order,'costBtc'),createdAt:order.createdAt,status:'CONFIRMED',existingEntry:true})];
              order.spendHistory=[...(order.spendHistory||[fundingRecord(paymentMarket(order),{at:order.createdAt,amountBtc:money(order,'costBtc')})]),fundingRecord(paymentMarket(q),{at:when,amountBtc:money(q,'costBtc'),note:'Paper team level addition'})];
              Object.assign(order,fundingRecord(paymentMarket(q),{...order,costBtc:money(order,'costBtc')+money(q,'costBtc')}));order.shares+=q.shares;
            }else{
              order=fundingRecord(paymentMarket(q),{id:id(),requestId:id(),mode:'paper',kind:'team',strategyId:strategy.id,packageId:q.id,name:q.name,coin:q.coin,shares:q.shares,costBtc:money(q,'costBtc'),feeBtc:0,refundBtc:0,status:'ACTIVE',createdAt:when,endAt:new Date(Date.now()+q.duration*1000).toISOString(),source:'Interactive paper demo',teamBuys:[]});s.orders.unshift(order);
            }
            order.teamBuys.push(fundingRecord(paymentMarket(q),{threshold:q.teamLevel.threshold,shares:q.shares,amountBtc:money(q,'costBtc'),requestId:id(),createdAt:when,status:'CONFIRMED'}));
            order.rewardEstimate=purchaseRewardEstimate(s.packages.find(p=>p.id===q.id),order.shares);
            strategy.lastBuyAt=when;this.event('Paper team level '+q.teamLevel.threshold+': +'+q.shares+' share(s) · '+q.name);
          }else{s.orders.unshift(fundingRecord(paymentMarket(q),{id:id(),mode:'paper',kind:strategy.mode,strategyId:strategy.id,packageId:q.id,name:q.name,coin:q.coin,shares:strategy.mode==='team'?strategy.shares:1,rewardEstimate:purchaseRewardEstimate(s.packages.find(p=>p.id===q.id),strategy.mode==='team'?strategy.shares:1),costBtc:money(q,'costBtc'),feeBtc:0,refundBtc:0,status:'ACTIVE',createdAt:stamp(),endAt:new Date(Date.now()+q.duration*1000).toISOString(),source:'Interactive paper demo'}));strategy.lastBuyAt=stamp();this.event('Paper purchase: '+q.name);}
        }}
      s.runtime.lastTick=stamp();s.runtime.decisions=decisions;this.event('Paper evaluation completed · '+decisions.filter(x=>x.reason==='Paper purchase created').length+' simulated purchases');
    }else if(path==='/api/sync'){throw new Error('Live synchronization is available in the self-hosted application. This preview uses an illustrative local ledger.');}
    else if(path==='/api/connection'||path==='/api/arm'){throw new Error('Connect API credentials in your self-hosted application. The hosted preview does not accept secrets.');}
    else if(path==='/api/import'){
      const plan=prepareConfigurationImport(body.backup,s,{...body.options,paperOnly:true,idFactory:id});
      s.settings=plan.settings;s.strategies=plan.strategies;
      for(const [key,q] of Object.entries(s.purchaseReviews||{}))if(!q.orderId)delete s.purchaseReviews[key];
      this.event('Configuration imported · '+plan.importedCount+' paused strategies · engine paused');
      this.persist();return {ok:true,importedStrategies:plan.importedCount,settingsRestored:body.options?.restoreSettings!==false};
    }
    else if(path==='/api/import-strategies'){
      if(!Array.isArray(body.strategies)||body.strategies.length>100)throw new Error('Expected up to 100 strategies');
      const clean=body.strategies.map(x=>({...validateStrategy({...x,enabled:false}),id:id(),lastBuyAt:null}));s.strategies.push(...clean);this.event('Imported '+clean.length+' paused strategies');
    }else if(path==='/api/reset-demo'){this.state=await createDemo();}
    else throw new Error('This action requires the self-hosted application');
    this.persist();return {ok:true};
  }
}
