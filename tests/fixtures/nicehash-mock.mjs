// Test-only preload. All NiceHash requests stay in this process. Only the named
// routing scenarios accept synthetic purchases; every other scenario forbids them.
import {createHmac} from 'node:crypto';
const originalFetch=globalThis.fetch;
const routeTeamId='01d3cfea-5296-4688-be94-c3cffb55fc83',routeSoloId='44444444-4444-4444-4444-444444444444';
const routeTeam={id:routeTeamId,status:'WAITING',state:'OPEN',minShareAmount:.0001,addedAmount:.0068,members:[],currencyAlgoTicket:{name:'Team Silver',currencyMarket:'BTC',available:true,price:.0041,minShareAmount:.0001,currencyAlgo:{currency:'BCH',blockRewardWithNhFee:3.125}}};
let syntheticPosts=0;
globalThis.fetch=async(input,options={})=>{
  const url=new URL(String(input));
  if(!['api2.nicehash.com','api-test.nicehash.com'].includes(url.hostname))return originalFetch(input,options);
  const reply=(data,status=200)=>new Response(JSON.stringify(data),{status});
  if(options.method==='POST'){
    const scenario=process.env.FP_TEST_SCENARIO;
    if(!['purchase-route-team','purchase-route-solo'].includes(scenario))throw new Error('Test fixture forbids provider purchases');
    // Follow the documented REST contract; a web-client path is not a fallback.
    const expected=scenario==='purchase-route-team'?'/main/api/v2/hashpower/shared/ticket/'+routeTeamId:'/main/api/v2/hashpower/solo/order';
    if(url.pathname!==expected)return reply({errors:[{code:110,message:'Unexpected path in the documented REST fixture'}]},404);
    if(++syntheticPosts>1)throw new Error('A single-use review submitted more than one provider POST');
    const h=options.headers,org='11111111-1111-1111-1111-111111111111',message=['mock-key',h['X-Time'],h['X-Nonce'],'',org,'','POST',expected,''].join('\0')+'\0'+options.body;
    if(h['X-Organization-Id']!==org||h['X-Auth']!=='mock-key:'+createHmac('sha256','mock-secret').update(message).digest('hex'))return reply({errors:[{code:2000,message:'Wrong route signed'}]},401);
    const body=JSON.parse(options.body);
    if(scenario==='purchase-route-team'){
      if(body.amount!==.0002||body.shares.small!==2||body.clear!==false)throw new Error('Unexpected synthetic team commitment');
      return reply({success:true,successType:'SUCCESSFUL'});
    }
    if(body.ticketId!==routeSoloId||body.buyWithCurrency!=='BTC')throw new Error('Unexpected synthetic solo purchase');
    return reply({id:'55555555-5555-4555-8555-555555555555',amount:.0001,status:{code:'PENDING'}});
  }
  if(url.pathname==='/api/v2/time')return reply({serverTime:Date.now()});
  if(url.pathname==='/main/api/v2/public/solo/package')return reply(['manual','purchase-route-solo'].includes(process.env.FP_TEST_SCENARIO)?[{id:routeSoloId,name:'Palladium S',price:.0001,available:true,currencyMarket:'BTC',duration:3600,currencyAlgo:{currency:'LTC'},mergeCurrencyAlgo:{currency:'DOGE'}}]:[]);
  if(url.pathname==='/main/api/v2/exchangeRate/list')return reply({list:[{fromCurrency:'BTC',toCurrency:'USD',exchangeRate:'95000'},{fromCurrency:'BTC',toCurrency:'EUR',exchangeRate:'88000'},{fromCurrency:'LTC',toCurrency:'USD',exchangeRate:'80'}]});
  if(url.pathname==='/main/api/v2/hashpower/sharedTicketExternalAddress/list')return reply([{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',currency:'LTC',address:'ltc1qmockdestination00000000',nickName:'Test LTC address'}]);
  if(url.pathname==='/main/api/v2/public/solo/shared/order')return reply({list:['purchase-route-team','levels-paper'].includes(process.env.FP_TEST_SCENARIO)?[routeTeam]:[]});
  if(url.pathname==='/main/api/v2/accounting/accounts2'){
    if(process.env.FP_TEST_SCENARIO==='provider-401')return reply({errors:[{code:2000,message:'Invalid Session'}]},401);
    if(!/^\d+$/.test(options.headers['X-Time']))return reply({errors:[{code:2000,message:'Non-integer timestamp'}]},401);
    return reply({currencies:[{currency:'BTC',available:'0.02000000',btcRate:1},...(['team-reward-shares','team-embedded','team-unattributed'].includes(process.env.FP_TEST_SCENARIO)?[{currency:'BCH',available:'0',btcRate:.0035}]:[])]});
  }
  if(['team-embedded','team-unattributed'].includes(process.env.FP_TEST_SCENARIO)&&url.pathname==='/main/api/v2/hashpower/solo/order'){
    const shared={id:'88888888-8888-4888-8888-888888888888',status:'CREATED',addedAmount:'.0041',minShareAmount:'.0001',currencyAlgoTicket:{name:'Team Silver',currencyMarket:'BTC',currencyAlgo:{currency:'BCH',blockRewardWithNhFee:3.125}},members:[{organizationId:'11111111-1111-1111-1111-111111111111',addedAmount:'.001',claimed:true,paymentStatus:'OK',rewards:[{coin:'BCH',rewardAmount:'.73934975365853658536',rewardFeeAmount:'.00746818'}]}]};
    return reply({list:[{id:'4a0f6fc4-d8df-4d7f-b2cc-7a4bb747f5cc',amount:.004033,status:'COMPLETED',soloMiningCoin:'BCH',createdTs:'2026-10-25T15:51:00Z',soloReward:[{id:'whole-team-block',coin:'BCH',payoutReward:303133399,payoutRewardBtc:.01046637,shared:true,depositComplete:true,createdTs:'2026-10-25T15:51:00Z'}],...(process.env.FP_TEST_SCENARIO==='team-embedded'?{sharedTicket:shared}:{})}]});
  }
  const rewardTeamId='66666666-6666-4666-8666-666666666666';
  if(process.env.FP_TEST_SCENARIO==='team-reward-shares'&&url.pathname==='/main/api/v2/hashpower/solo/order')return reply({list:[{id:'77777777-7777-4777-8777-777777777777',sharedTicketId:rewardTeamId,myAddedAmount:.001,amount:.0041,currencyMarket:'BTC',status:'COMPLETED',soloMiningCoin:'BCH',createdTs:'2026-10-25T15:51:00Z',soloReward:[{id:'whole-block',coin:'BCH',payoutReward:312500000,depositComplete:true}]}]});
  if(url.pathname==='/main/api/v2/hashpower/solo/order')return reply({list:process.env.FP_TEST_SCENARIO==='auto-external'?[{id:'55555555-5555-5555-5555-555555555555',organizationId:'11111111-1111-1111-1111-111111111111',amount:.0001,currencyMarket:'BTC',soloMiningCoin:'BTC',status:'ACTIVE',createdTs:new Date().toISOString(),soloReward:[]}]:['catalogue-and-usdt','team-decimals','team-invalid-amount'].includes(process.env.FP_TEST_SCENARIO)?Array.from({length:process.env.FP_TEST_SCENARIO==='catalogue-and-usdt'?6:4},(_,i)=>({id:'usdt-owned-'+i,currencyMarket:'USDT'})):[]});
  const id='22222222-2222-2222-2222-222222222222';
  const scenario=process.env.FP_TEST_SCENARIO;
  const foreign={organizationId:'33333333-3333-3333-3333-333333333333',addedAmount:1};
  const my={organizationId:'11111111-1111-1111-1111-111111111111',addedAmount:.0001};
  const team=members=>({id,status:'WAITING',members,currencyAlgoTicket:{currencyMarket:'BTC',name:'Team Gold',currencyAlgo:{currency:'BTC'}}});
  const decimalTeam={...team([{...my,paymentStatus:'OK',addedAmount:scenario==='team-invalid-amount'?null:{value:'1.000000000E-4'},rewards:[{coin:'BTC',rewardAmount:'0E-8',rewardFeeAmount:'0.000000000000'}]}]),id:'4f6f9902-63bd-4bea-b216-8ec7839835a4'};
  const rewardTeam={id:rewardTeamId,status:'COMPLETED',addedAmount:'0.0041',minShareAmount:'0.0001',currencyAlgoTicket:{currencyMarket:'BTC',name:'Team Silver',currencyAlgo:{currency:'BCH',blockRewardWithNhFee:'3.125'}},members:[{...my,addedAmount:'0.001',claimed:true,paymentStatus:'OK',rewards:[{coin:'BCH',rewardAmount:'0.76219512195121951219',rewardFeeAmount:0}]}],orderDetails:{id:'77777777-7777-4777-8777-777777777777',soloReward:[{coin:'BCH',depositComplete:true,payoutReward:312500000}]}};
  if(url.pathname==='/main/api/v2/hashpower/solo/shared/order'){
    if(scenario==='purchase-route-team')return reply({list:[routeTeam]});
    if(scenario==='rejected-team')return reply({list:[{...team([]),id:'6bc903de-f736-4add-a1fc-436dd5cd2b89'}]});
    if(scenario==='team-reward-shares')return reply({list:[rewardTeam]});
    if(['team-decimals','team-invalid-amount'].includes(scenario))return reply({list:[decimalTeam]});
    if(scenario==='catalogue-and-usdt')return reply({list:['d10e6bd9-beeb-480c-80f7-ca1fc6c2fae5','f82d49d3-27c2-4fea-8e77-43d1d38d2b18','54cb1ab5-1be8-4b90-bd85-b64d1a80ce92','c90a83ae-ea32-41c9-b6fc-98eb83664e7b'].map(id=>({...team(null),id}))});
    return reply({list:scenario==='missing-member'?[team([foreign])]:scenario==='redacted-member'?[team([{addedAmount:.0001}])]:scenario==='owned-member'?[team([foreign,my])]:[]});
  }
  if(url.pathname==='/main/api/v2/hashpower/solo/shared/order/'+rewardTeamId)return reply(rewardTeam);
  if(url.pathname==='/main/api/v2/hashpower/solo/shared/order/'+decimalTeam.id)return reply(decimalTeam);
  if(url.pathname==='/main/api/v2/hashpower/solo/shared/order/'+id)return reply(team(scenario==='redacted-member'?[{addedAmount:.0001}]:scenario==='owned-member'?[foreign,my]:[foreign]));
  return reply({errors:[{code:9999}]},404);
};
