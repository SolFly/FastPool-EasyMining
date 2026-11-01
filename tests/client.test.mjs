import test from 'node:test';
import assert from 'node:assert/strict';
import {createHttpClient} from '../public/http-client.mjs';
import {ApiError} from '../server/nicehash.mjs';
import {errorResponse} from '../server/http-errors.mjs';
test('a NiceHash 401 maps to an upstream error rather than dashboard authentication',async()=>{
  const mapped=errorResponse(new ApiError('Invalid Session',{status:401,nicehashCode:2000,method:'GET',path:'/main/api/v2/accounting/accounts2',requestId:'safe-reference'}));
  assert.equal(mapped.status,502);assert.equal(mapped.body.provider.httpStatus,401);assert.equal(mapped.body.provider.code,2000);
  let loggedOut=false;const client=createHttpClient({fetcher:async()=>new Response(JSON.stringify(mapped.body),{status:mapped.status}),onAuthRequired:()=>loggedOut=true});
  await assert.rejects(()=>client('/api/sync','POST',{}),/Invalid Session/);assert.equal(loggedOut,false);
});
test('even a legacy provider 401 cannot expire a dashboard session without AUTH_REQUIRED',async()=>{
  let loggedOut=false;const client=createHttpClient({fetcher:async()=>new Response('{"error":"NiceHash Invalid Session"}',{status:401}),onAuthRequired:()=>loggedOut=true});
  await assert.rejects(()=>client('/api/sync','POST',{}),/NiceHash/);assert.equal(loggedOut,false);
});
test('a genuine expired dashboard session still requests sign-in',async()=>{
  let loggedOut=false;const client=createHttpClient({fetcher:async()=>new Response('{"error":"Sign in","code":"AUTH_REQUIRED"}',{status:401}),onAuthRequired:()=>loggedOut=true});
  await assert.rejects(()=>client('/api/state'),/sign in/i);assert.equal(loggedOut,true);
});
