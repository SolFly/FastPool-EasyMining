import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {NiceHash,sign,soloReward} from '../server/nicehash.mjs';
const credentials={key:'test-key',secret:'test-secret',orgId:'12345678-1234-1234-1234-123456789012'};
test('ordinary solo buying preserves the working v1.2.4 REST route and exact HMAC body',async()=>{
  let captured;const api=new NiceHash(credentials,async(url,options)=>{captured={url,...options};return new Response('{"id":"order-id","amount":0.0001,"status":{"code":"PENDING"}}');});
  await api.buy({id:'package-id',market:'BTC',costBtc:10000},{mode:'solo'},'stable-request-id');
  assert.equal(captured.url,'https://api2.nicehash.com/main/api/v2/hashpower/solo/order');
  assert.deepEqual(JSON.parse(captured.body),{ticketId:'package-id',buyWithCurrency:'BTC'});
  const h=captured.headers;
  const msg=credentials.key+'\0'+h['X-Time']+'\0'+h['X-Nonce']+'\0\0'+credentials.orgId+'\0\0POST\0/main/api/v2/hashpower/solo/order\0\0'+captured.body;
  assert.equal(h['X-Auth'],credentials.key+':'+createHmac('sha256',credentials.secret).update(msg).digest('hex'));
  assert.equal(h['X-Request-Id'],'stable-request-id');
});
test('ordinary team shares preserve the working v1.2.4 REST route, payload and signature',async()=>{
  let captured;const api=new NiceHash(credentials,async(url,o)=>{captured={url,...o};return new Response('{"success":true,"successType":"SUCCESSFUL"}');});
  await api.buy({id:'team-id',market:'BTC',costBtc:30000},{mode:'team',shares:3},'request-id');
  assert.deepEqual(JSON.parse(captured.body),{amount:0.0003,shares:{small:3},clear:false});
  assert.equal(captured.url,'https://api2.nicehash.com/main/api/v2/hashpower/shared/ticket/team-id');
  const h=captured.headers,msg=credentials.key+'\0'+h['X-Time']+'\0'+h['X-Nonce']+'\0\0'+credentials.orgId+'\0\0POST\0/main/api/v2/hashpower/shared/ticket/team-id\0\0'+captured.body;
  assert.equal(h['X-Auth'],credentials.key+':'+createHmac('sha256',credentials.secret).update(msg).digest('hex'));assert.equal(h['X-Request-Id'],'request-id');
});
test('a rejection on the documented team REST route is returned once without a fallback POST',async()=>{
 const targets=[],api=new NiceHash(credentials,async(url)=>{targets.push(url);return new Response('{"errors":[{"code":110,"message":"The requested resource was not found"}]}',{status:404});});
 await assert.rejects(()=>api.buy({id:'01d3cfea-5296-4688-be94-c3cffb55fc83',market:'BTC',costBtc:10000},{mode:'team',shares:1},'one-request'),e=>e.upstreamStatus===404&&e.nicehashCode===110&&e.path==='/main/api/v2/hashpower/shared/ticket/01d3cfea-5296-4688-be94-c3cffb55fc83');
 assert.deepEqual(targets,['https://api2.nicehash.com/main/api/v2/hashpower/shared/ticket/01d3cfea-5296-4688-be94-c3cffb55fc83']);
});
test('test-environment purchases use the same service path and never switch environment',async()=>{
 let target;const api=new NiceHash({...credentials,baseUrl:'https://api-test.nicehash.com'},async(url)=>{target=url;return new Response('{"success":true,"successType":"SUCCESSFUL"}');});
 await api.buy({id:'team',market:'BTC',costBtc:10000},{mode:'team',shares:1},'request');assert.equal(target,'https://api-test.nicehash.com/main/api/v2/hashpower/shared/ticket/team');
});
test('purchase timeouts and 5xx responses are uncertain and never retried',async()=>{
  let calls=0;const api=new NiceHash(credentials,async()=>{calls++;throw new Error('network timeout');});
  await assert.rejects(()=>api.buy({id:'x',market:'BTC',costBtc:10000},{mode:'solo'},'id'),e=>e.uncertain===true);assert.equal(calls,1);
  api.fetcher=async()=>new Response('{"errors":[{"code":2999}]}',{status:500});
  await assert.rejects(()=>api.buy({id:'x',market:'BTC',costBtc:10000},{mode:'solo'},'id'),e=>e.uncertain===true);
});
test('unsuccessful or partial team responses require reconciliation',async()=>{
  const api=new NiceHash(credentials,async()=>new Response('{"success":true,"successType":"PARTIAL_SUCCESS"}'));
  await assert.rejects(()=>api.buy({id:'x',market:'BTC',costBtc:10000},{mode:'team',shares:1},'id'),e=>e.uncertain===true);
});
test('solo confirmation requires depositComplete; confirmed valuation is frozen',()=>{
  const raw={id:'r',coin:'BTC',payoutReward:100,createdTs:'2026-10-26T10:00:00Z',payoutRewardBtc:.000001,confirmations:100};
  assert.equal(soloReward(raw,'o').confirmed,false);
  const r=soloReward({...raw,depositComplete:true},'o');assert.equal(r.confirmed,true);assert.equal(r.valueBtc,100);
  assert.equal(soloReward({...raw,depositComplete:true,payoutRewardBtc:.000002},'o',r).valueBtc,100);
});
test('USDT priced packages cannot be submitted by the adapter',async()=>{
  let calls=0;const api=new NiceHash(credentials,async()=>{calls++;});await assert.rejects(()=>api.buy({market:'USDT'},{mode:'solo'},'id'));assert.equal(calls,0);
});
test('half-millisecond clock corrections always produce an integer X-Time header',async()=>{
  let time;const api=new NiceHash(credentials,async(url,o)=>{time=o.headers['X-Time'];return new Response('{"currencies":[]}');});
  for(const offset of [.5,-.5,123.25]){api.offset=offset;await api.balances();assert.match(time,/^\d+$/);assert.ok(Number.isSafeInteger(Number(time)));}
});
test('request signing and dispatch use the configured official API base',async()=>{
  let target;const api=new NiceHash({...credentials,baseUrl:'https://api-test.nicehash.com'},async(url)=>{target=url;return new Response('{"currencies":[]}');});
  await api.balances();assert.ok(target.startsWith('https://api-test.nicehash.com/main/api/v2/accounting/accounts2?'));
});
test('saved primary and merged addresses use the correct provider IDs and currency match',async()=>{
 const requests=[],addresses=[{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',currency:'LTC',address:'ltc1qexampledestination00000',organizationId:credentials.orgId},{id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',currency:'DOGE',address:'DExampleDestination00000',organizationId:credentials.orgId}];
 const api=new NiceHash(credentials,async(url,o)=>{requests.push({url,...o});return new Response(JSON.stringify(o.method==='GET'?addresses:{success:true,successType:'SUCCESSFUL'}));});
 await api.buy({id:'team',market:'BTC',coin:'LTC',mergeCoin:'DOGE',costBtc:20000},{mode:'team',shares:2,payoutAddress:addresses[0].address,mergePayoutAddress:addresses[1].address},'r');
 const post=requests.find(r=>r.method==='POST');assert.deepEqual(JSON.parse(post.body),{amount:.0002,shares:{small:2},clear:false,soloMiningRewardWithdrawalAddrId:addresses[0].id,mergeSoloMiningRewardWithdrawalAddrId:addresses[1].id});
 assert.equal(post.headers['X-Twofa-Token'],undefined);assert.equal(requests.length,2);
});
test('unsaved payout address requires 2FA; code is sent as a header and never in a purchase body',async()=>{
 let post;const api=new NiceHash(credentials,async(url,o)=>{if(o.method==='GET')return new Response('[]');post=o;return new Response('{"id":"order","amount":0.0001,"status":{"code":"PENDING"}}');});
 const q={id:'solo',market:'BTC',coin:'BTC',costBtc:10000},s={mode:'solo',payoutAddress:'bc1qexampledestination00000'};
 await assert.rejects(()=>api.buy(q,s,'r'),/2FA/);assert.equal(post,undefined);
 await api.buy(q,s,'r',{twofaToken:'123456'});assert.equal(post.headers['X-Twofa-Token'],'123456');assert.equal(JSON.parse(post.body).soloMiningRewardAddr,s.payoutAddress);assert.ok(!post.body.includes('123456'));
});
test('saved destinations from a different organization or reward coin are never substituted',async()=>{
 let postCount=0;const api=new NiceHash(credentials,async(url,o)=>{if(o.method==='POST'){postCount++;return new Response('{}');}return new Response(JSON.stringify([{id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',currency:'DOGE',address:'bc1qexampledestination00000',organizationId:credentials.orgId},{id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',currency:'BTC',address:'bc1qexampledestination00000',organizationId:'someone-else'}]));});
 await assert.rejects(()=>api.buy({id:'p',market:'BTC',coin:'BTC',costBtc:10000},{mode:'solo',payoutAddress:'bc1qexampledestination00000'},'r'),/2FA/);assert.equal(postCount,0);
});
test('interrupted purchase bodies and malformed debit responses remain uncertain',async()=>{
 const api=new NiceHash(credentials,async()=>({ok:true,status:200,text:async()=>{throw new Error('interrupted');}}));
 await assert.rejects(()=>api.buy({id:'p',market:'BTC',costBtc:10000},{mode:'solo'},'r'),e=>e.uncertain===true);
 api.fetcher=async()=>new Response('{"id":"accepted","amount":"garbled"}');
 await assert.rejects(()=>api.buy({id:'p',market:'BTC',costBtc:10000},{mode:'solo'},'r'),e=>e.uncertain===true);
});
