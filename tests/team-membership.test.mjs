import test from 'node:test';
import assert from 'node:assert/strict';
import {teamMembership} from '../server/team-membership.mjs';
test('available teams with absent, null or empty members are not purchase records',()=>{
  for(const raw of [{},{members:null},{members:[]}])assert.equal(teamMembership(raw,'mine').state,'unjoined');
});
test('explicit foreign members cannot be mistaken for an owned purchase',()=>{
  assert.equal(teamMembership({members:[{organizationId:'other',addedAmount:3}]},'mine').state,'unrelated');
});
test('an identified own member wins over other participants and UUID case',()=>{
  const my={organizationId:'MINE',addedAmount:.0001};const result=teamMembership({members:[{organizationId:'other',addedAmount:3},my]},'mine');assert.equal(result.state,'owned');assert.equal(result.member,my);
});
test('redacted member spend and explicit personal spend still require attribution',()=>{
  assert.equal(teamMembership({members:[{addedAmount:.0001}]},'mine').state,'unattributed');
  assert.equal(teamMembership({members:null,myAddedAmount:.0001},'mine').state,'unattributed');
});
