import test from 'node:test';
import assert from 'node:assert/strict';
import {accountTeamReference,personalSoloProof} from '../server/order-links.mjs';
import {validateSettings,DEFAULTS} from '../public/core.mjs';
test('explicit team references identify shared executions without inspecting their full team amount',()=>{
 assert.deepEqual(accountTeamReference({id:'execution',sharedTicketId:'team',amount:100}),{teamId:'team',orderId:'execution',explicit:true});
 assert.equal(accountTeamReference({id:'execution',sharedTicketId:{id:'team'}}).teamId,'team');
 assert.equal(accountTeamReference({id:'execution',myAddedAmount:'1E-4'}).explicit,false);
});
test('absent or zero personal team contribution does not turn a solo record into a shared purchase',()=>{
 for(const value of [undefined,null,0,'0E-8',{value:'0.000000000'}])assert.equal(accountTeamReference({id:'solo',myAddedAmount:value}),null);
 assert.throws(()=>accountTeamReference({id:'invalid',sharedTicketId:{}}),/invalid sharedTicketId/);
});
test('automatic syncing settings validate independently from strategy execution settings',()=>{
 assert.equal(validateSettings({autoSync:false,accountSyncSeconds:30},DEFAULTS).autoSync,false);
 for(const n of [0,29,3601,NaN])assert.throws(()=>validateSettings({accountSyncSeconds:n}),/accountSyncSeconds/);
 assert.throws(()=>validateSettings({autoSync:'false'}),/autoSync/);
});
test('current NiceHash history embeds team membership as sharedTicket',()=>{
 const embedded={id:'actual-team',members:[{organizationId:'mine',addedAmount:.001}]};
 const ref=accountTeamReference({id:'execution',sharedTicket:embedded});assert.equal(ref.teamId,'actual-team');assert.equal(ref.orderId,'execution');assert.equal(ref.embedded,embedded);
 assert.throws(()=>accountTeamReference({id:'execution',sharedTicket:{},sharedTicketId:'different'}),/invalid/);
 assert.throws(()=>accountTeamReference({id:'execution',sharedTicket:embedded,sharedTicketId:'different'}),/Conflicting/);
});
test('shared and grouped reward flags never fall through to solo accounting',()=>{
 const ref=accountTeamReference({id:'execution',soloReward:[{shared:true,packageId:'team'}]});assert.equal(ref.teamId,'team');assert.equal(ref.rewardReference,true);
 assert.equal(accountTeamReference({id:'execution',soloReward:[{groupedRewards:[{shared:true}]}]}).teamId,null);
 assert.throws(()=>accountTeamReference({id:'execution',soloReward:[{shared:true,packageId:'one'},{shared:true,packageId:'two'}]}),/several/);
});
test('personal solo attribution requires positive private order or reward evidence',()=>{
 assert.ok(personalSoloProof({organizationId:'MINE'},'mine'));assert.ok(personalSoloProof({sharedTicket:null},'mine'));
 assert.ok(personalSoloProof({soloReward:[{shared:false}]},'mine'));
 assert.equal(personalSoloProof({organizationId:'different',sharedTicket:null},'mine'),null);assert.equal(personalSoloProof({soloReward:[{}]},'mine'),null);
});
