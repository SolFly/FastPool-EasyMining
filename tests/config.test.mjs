import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadServerConfig,normalizeCredentials} from '../server/config.mjs';
const env={NICEHASH_API_KEY:'test-api-key',NICEHASH_API_SECRET:'test-api-secret',NICEHASH_ORGANIZATION_ID:'ABCDEF00-1234-1234-1234-123456789012'};
test('server accepts the existing nicehash JSON format and resolves environment placeholders',()=>{
  const c=normalizeCredentials({nicehash:{api_key:'${NICEHASH_API_KEY}',api_secret:'${NICEHASH_API_SECRET}',organization_id:'${NICEHASH_ORGANIZATION_ID}',base_url:'https://api2.nicehash.com'}},env);
  assert.equal(c.key,env.NICEHASH_API_KEY);assert.equal(c.secret,env.NICEHASH_API_SECRET);assert.equal(c.orgId,env.NICEHASH_ORGANIZATION_ID.toLowerCase());assert.equal(c.baseUrl,'https://api2.nicehash.com');
});
test('missing environment references fail locally without leaking their values',()=>{
  assert.throws(()=>normalizeCredentials({nicehash:{api_key:'${NICEHASH_API_KEY}',api_secret:'${NICEHASH_API_SECRET}',organization_id:env.NICEHASH_ORGANIZATION_ID}},{NICEHASH_API_KEY:env.NICEHASH_API_KEY}),/NICEHASH_API_SECRET is not set/);
});
test('credential cleanup removes accidental wrapping quotes and invisible pasted characters',()=>{
  const c=normalizeCredentials({key:' \uFEFF"test-api-key" ',secret:" 'test-api-secret' ",orgId:env.NICEHASH_ORGANIZATION_ID,baseUrl:'https://api2.nicehash.com/'});
  assert.equal(c.key,'test-api-key');assert.equal(c.secret,'test-api-secret');assert.equal(c.baseUrl,'https://api2.nicehash.com');
});
test('base URL accepts official production/test APIs and rejects credential exfiltration URLs',()=>{
  const c={key:'k',secret:'s',orgId:env.NICEHASH_ORGANIZATION_ID};
  assert.equal(normalizeCredentials({...c,base_url:'https://api-test.nicehash.com'}).baseUrl,'https://api-test.nicehash.com');
  for(const u of ['https://attacker.example','https://api2.nicehash.com@attacker.example','https://api2.nicehash.com/path','http://api2.nicehash.com'])assert.throws(()=>normalizeCredentials({...c,base_url:u}));
});
test('server reads a config.json file and reports an unresolved variable without returning secrets',t=>{
  const root=mkdtempSync(join(tmpdir(),'fp-config-'));t.after(()=>rmSync(root,{force:true,recursive:true}));
  writeFileSync(join(root,'config.json'),JSON.stringify({nicehash:{api_key:'${NICEHASH_API_KEY}',api_secret:'${NICEHASH_API_SECRET}',organization_id:'${NICEHASH_ORGANIZATION_ID}'}}));
  assert.equal(loadServerConfig({root,env}).credentials.key,env.NICEHASH_API_KEY);
  const bad=loadServerConfig({root,env:{NICEHASH_API_KEY:env.NICEHASH_API_KEY}});assert.equal(bad.credentials,null);assert.match(bad.error,/NICEHASH_API_SECRET/);assert.ok(!bad.error.includes(env.NICEHASH_API_KEY));
});
