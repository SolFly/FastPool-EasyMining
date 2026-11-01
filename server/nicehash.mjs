import {createHmac,randomUUID} from 'node:crypto';
import {decimal,normalizePackage,payoutFields} from '../public/core.mjs';
import {normalizeRates} from '../public/rewards.mjs';
import {providerUnits} from '../public/provider-amounts.mjs';
import {TEAM_PURCHASE_PATH,SOLO_PURCHASE_PATH} from '../public/purchase-status.mjs';
import {teamMembership} from './team-membership.mjs';
import {baseUrl} from './config.mjs';
export const BASE='https://api2.nicehash.com';
export function sign({key,secret,orgId},method,path,query,time,nonce,body=''){
  const message=[key,String(time),nonce,'',orgId,'',method,path,query].join('\0')+(body?'\0'+body:'');
  return key+':'+createHmac('sha256',secret).update(message).digest('hex');
}
export class ApiError extends Error{constructor(message,{status=0,uncertain=false,nicehashCode=null,method=null,path=null,requestId=null,clockOffsetMs=null,providerMessage=null}={}){
  super(message);this.name='NiceHashApiError';this.code='NICEHASH_API_ERROR';this.status=502;this.upstreamStatus=status;
  Object.assign(this,{uncertain,nicehashCode,method,path,requestId,clockOffsetMs,providerMessage});
}}
export class NiceHash {
  constructor(credentials,fetcher=fetch){this.credentials=credentials;this.baseUrl=baseUrl(credentials?.baseUrl||credentials?.base_url||BASE);this.fetcher=fetcher;this.offset=0;this.clockAt=0;}
  async request(method,path,{query={},body,privateCall=true,requestId=randomUUID(),twofaToken=''}={}){
    if(!path.startsWith('/'))throw new Error('Invalid API path');
    const q=new URLSearchParams(query).toString(),payload=body===undefined?'':JSON.stringify(body);
    const headers={'Content-Type':'application/json','Accept':'application/json','User-Agent':'FastPool-EasyMining/1.4.2'};
    const details={method,path,requestId,clockOffsetMs:Math.round(this.offset)};
    if(privateCall){
      if(!this.credentials)throw new Error('Connect a NiceHash API key first');
      // Clock midpoint calculations can contain half milliseconds. X-Time must be an integer.
      const time=String(Math.round(Date.now()+this.offset)),nonce=randomUUID();
      Object.assign(headers,{'X-Time':time,'X-Nonce':nonce,'X-Organization-Id':this.credentials.orgId,
        'X-Auth':sign(this.credentials,method,path,q,time,nonce,payload),'X-Request-Id':requestId});
      if(twofaToken){if(!/^\d{6,8}$/.test(twofaToken))throw new Error('Enter the current NiceHash 2FA code (6–8 digits)');headers['X-Twofa-Token']=twofaToken;}
    }
    let response;
    try{response=await this.fetcher(this.baseUrl+path+(q?'?'+q:''),{method,headers,body:payload||undefined,signal:AbortSignal.timeout(20000),redirect:'error'});}
    catch{throw new ApiError(method==='POST'?'Purchase response was not received. Verify the order in NiceHash before reconciling.':'NiceHash request timed out or could not connect',{...details,uncertain:method==='POST'});}
    let text;try{text=await response.text();}catch{throw new ApiError('NiceHash response was interrupted',{...details,status:response.status,uncertain:method==='POST'});}let data;
    try{data=JSON.parse(text);}catch{throw new ApiError('NiceHash returned a non-JSON response (HTTP '+response.status+')',{...details,status:response.status,uncertain:method==='POST'});}
    if(!response.ok||data?.error||data?.errors?.length){
      const code=data?.errors?.[0]?.code||data?.error?.code||'unknown';
      let providerMessage=String(data?.errors?.[0]?.message||data?.error?.message||(typeof data?.error==='string'?data.error:'')).replace(/[\x00-\x1f\x7f]/g,' ');
      for(const secret of [this.credentials?.key,this.credentials?.secret,twofaToken])if(secret)providerMessage=providerMessage.split(secret).join('[redacted]');
      providerMessage=providerMessage.slice(0,300)||null;
      const hint=response.status===401?' Check the API key/secret pair, organization ID, key activation and any IP restriction.':response.status===403?' Check the API key permissions for this endpoint.':'';
      throw new ApiError('NiceHash rejected '+method+' '+path+' (HTTP '+response.status+', code '+code+').'+(providerMessage?' '+providerMessage:'')+hint,{...details,status:response.status,nicehashCode:code,providerMessage,uncertain:method==='POST'&&([408,409].includes(response.status)||response.status>=500)});
    }
    return data;
  }
  async syncClock(){const begin=Date.now(),r=await this.request('GET','/api/v2/time',{privateCall:false});const serverTime=Number(r.serverTime);if(!Number.isSafeInteger(serverTime)||serverTime<=0)throw new Error('Unexpected server time response');this.offset=Math.round(serverTime-(begin+Date.now())/2);this.clockAt=Date.now();}
  async packages(){
    const solo=await this.request('GET','/main/api/v2/public/solo/package',{privateCall:false});
    if(!Array.isArray(solo))throw new Error('Unexpected package catalogue response');
    const team=await this.pages('/main/api/v2/public/solo/shared/order',{privateCall:false,query:{onlyGold:false}});
    const at=new Date().toISOString();return [...solo.map(p=>normalizePackage(p,at)),...team.map(p=>normalizePackage(p,at,true))];
  }
  async pages(path,{privateCall=true,query={}}={}){
    const results=[];
    for(let page=0;page<50;page++){
      const d=await this.request('GET',path,{privateCall,query:{...query,page,limit:100}});
      if(!Array.isArray(d.list))throw new Error('Unexpected ticket list schema');
      results.push(...d.list);if(d.list.length<100)return results;
    }
    throw new Error('History exceeded 5,000 tickets; import is incomplete and buying is paused');
  }
  async balances(){return this.request('GET','/main/api/v2/accounting/accounts2',{query:{extendedResponse:true,fiat:'USD'}});}
  async exchangeRates(){return normalizeRates(await this.request('GET','/main/api/v2/exchangeRate/list',{privateCall:false}));}
  async payoutAddresses(currency=''){
    if(currency&&!/^[A-Z0-9]{2,12}$/.test(currency))throw new Error('Invalid payout currency');
    const data=await this.request('GET','/main/api/v2/hashpower/sharedTicketExternalAddress/list',{query:currency?{currency}:{}});
    if(!Array.isArray(data))throw new Error('Unexpected saved payout address response');
    return data.filter(a=>a.address&&a.currency&&(!a.organizationId||a.organizationId.toLowerCase()===this.credentials.orgId.toLowerCase()))
      .map(a=>({id:a.id,currency:a.currency,address:a.address,name:a.nickName||''}));
  }
  async payoutDestination(q,input){
    const payout=payoutFields(input),fields={};let requiresTwofa=false;
    if(payout.mergePayoutAddress&&!q.mergeCoin)throw new Error('This package has no merged reward coin');
    if(q.withdrawRewards&&(!payout.payoutAddress||(q.mergeCoin&&!payout.mergePayoutAddress)))throw new Error('This package requires a payout address for each reward coin');
    if(!payout.payoutAddress&&!payout.mergePayoutAddress)return {fields,requiresTwofa};
    const saved=await this.payoutAddresses();
    for(const [address,currency,prefix] of [[payout.payoutAddress,q.coin,'soloMiningReward'],[payout.mergePayoutAddress,q.mergeCoin,'mergeSoloMiningReward']]){
      if(!address)continue;
      const match=saved.find(a=>a.currency===currency&&a.address===address);
      if(match){if(!/^[a-f0-9-]{36}$/i.test(match.id))throw new Error('Saved NiceHash address has an invalid ID');fields[prefix+'WithdrawalAddrId']=match.id;}
      else{fields[prefix+'Addr']=address;requiresTwofa=true;}
    }
    return {fields,requiresTwofa};
  }
  async ticket(id,team=false){if(!/^[a-f0-9-]{36}$/i.test(id))throw new Error('Invalid NiceHash ticket ID');return this.request('GET','/main/api/v2/hashpower/solo/'+(team?'shared/':'')+'order/'+id);}
  async prepareTeamLevel(q,s,before){
    const raw=await this.ticket(q.id,true),pkg=normalizePackage(raw,new Date().toISOString(),true),ownership=teamMembership(raw,this.credentials.orgId),m=ownership.member;
    if(raw.id!==q.id||!pkg.available||(raw.state&&!['OPEN','PENDING'].includes(raw.state))||pkg.market!=='BTC'||pkg.coin!==q.coin||(pkg.mergeCoin||null)!==(q.mergeCoin||null)||pkg.costBtc!==q.costBtc/s.shares||pkg.teamShares<q.teamLevel.threshold)throw Object.assign(new Error('Team or level price changed; wait for a new evaluation'),{code:'TEAM_QUOTE_CHANGED',status:409});
    if(ownership.state==='unattributed')throw new Error('Team membership cannot be verified before adding shares');
    const cost=m?providerUnits(m.addedAmount,'team member addedAmount'):0,shares=cost/pkg.minShare;
    if(!Number.isSafeInteger(shares)||cost!==(before?.costBtc||0)||shares!==(before?.shares||0)||(m?.paymentStatus&&m.paymentStatus!=='OK'))throw new Error('Team participation changed; sync the account before adding shares');
    if(m?.shares&&Object.entries(m.shares).some(([key,value])=>key!=='small'&&Number(value)!==0))throw new Error('Automatic additions support small shares without coupons or mass buys');
    if(m?.shares?.small!==undefined&&Number(m.shares.small)!==shares)throw new Error('Team share quantities do not match the verified contribution');
    return {package:pkg,update:{beforeCostBtc:cost,beforeShares:shares,targetCostBtc:cost+q.costBtc,targetShares:shares+s.shares}};
  }
  async buy(q,s,requestId,{twofaToken='',destination=null,teamUpdate=null}={}){
    if(q.market!=='BTC')throw new Error('Only BTC-priced packages are supported for automated buying');
    const payout=destination||await this.payoutDestination(q,s);
    if(payout.requiresTwofa&&!/^\d{6,8}$/.test(twofaToken))throw new Error('An unsaved payout address requires a current NiceHash 2FA code. Save the address in NiceHash for automatic strategy purchases.');
    const fields=payout.fields;
    if(s.mode==='team'){
      if(teamUpdate&&(!Object.values(teamUpdate).every(n=>Number.isSafeInteger(n)&&n>=0)||teamUpdate.targetCostBtc!==teamUpdate.beforeCostBtc+q.costBtc||teamUpdate.targetShares!==teamUpdate.beforeShares+s.shares))throw new Error('Invalid cumulative team purchase');
      const d=await this.request('POST',TEAM_PURCHASE_PATH+q.id,{requestId,twofaToken,body:{amount:Number(decimal(teamUpdate?.targetCostBtc??q.costBtc)),shares:{small:teamUpdate?.targetShares??s.shares},clear:false,...fields}});
      if(d.success!==true||d.successType==='NOT_SUCCESSFUL'||d.successType==='PARTIAL_SUCCESS')throw new ApiError('Team purchase response requires reconciliation',{uncertain:true});
      return {id:q.id,status:'PENDING',costBtc:q.costBtc};
    }
    const d=await this.request('POST',SOLO_PURCHASE_PATH,{requestId,twofaToken,body:{ticketId:q.id,buyWithCurrency:'BTC',...fields}});
    if(!d.id)throw new ApiError('Purchase response has no order ID',{uncertain:true});
    let costBtc;try{costBtc=providerUnits(d.amount??decimal(q.costBtc),'purchase debit amount');if(costBtc<=0)throw new Error();}catch{throw new ApiError('Purchase response has an invalid debit amount; verify the order in NiceHash',{uncertain:true});}
    return {id:d.id,status:d.status?.code||'PENDING',costBtc};
  }
}
export function normalizeStatus(raw){
  const s=raw?.code||raw;
  if(['ACTIVE','CREATED'].includes(s))return 'ACTIVE';
  if(['WAITING','COUNTDOWN','SPAWNING','PENDING','PENDING_CANCELLATION'].includes(s))return 'PENDING';
  if(['COMPLETED','EXPIRED','DEAD'].includes(s))return 'COMPLETED';
  return 'UNKNOWN';
}
export function soloReward(raw,orderId,previous){
  if(raw.shared===true)throw new Error('A shared team reward cannot be recorded as a personal solo payout');
  if(!raw.id)throw new Error('Reward response has no stable ID');
  if(!Number.isSafeInteger(raw.payoutReward))throw new Error('Reward amount exceeds safe integer precision');
  return {id:raw.id,orderId,coin:raw.coin,amount:raw.payoutReward,createdAt:raw.createdTs||new Date(raw.time).toISOString(),
    confirmed:(raw.depositComplete===true&&!raw.depositDonated)||!!previous?.manualConfirmed,
    manualConfirmed:previous?.manualConfirmed||null,
    confirmedAt:(raw.depositComplete===true||previous?.manualConfirmed)?(previous?.confirmedAt||new Date().toISOString()):null,
    confirmations:raw.confirmations||0,minConfirmations:raw.minConfirmations||0,
    valueBtc:previous?.confirmed?previous.valueBtc:(raw.payoutRewardBtc!==undefined&&raw.payoutRewardBtc!==null?providerUnits(raw.payoutRewardBtc,'solo reward BTC value'):(raw.coin==='BTC'?raw.payoutReward:null)),
    scope:'personal-solo',providerShared:raw.shared??null,providerPackageId:raw.packageId||null,
    valuation:'NiceHash reported BTC equivalent; not an executed conversion',blockHeight:raw.blockHeight,tx:raw.tx||''};
}
