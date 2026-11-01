import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULTS,STRATEGY_DEFAULTS,validateSettings,pickQuote,guard} from '../public/core.mjs';
import {rejectedTeamTarget} from '../public/purchase-status.mjs';
import {requestProfilePanel,purchaseProfile} from '../public/request-profiles.mjs';
import {configurationBackup,parseConfigurationBackup} from '../public/config-backup.mjs';

const id='44444444-4444-4444-8444-444444444444';
const pkg={id,coin:'BCH',name:'Team Silver',team:true,market:'BTC',available:true,teamShares:68,costBtc:10000,quotedAt:new Date().toISOString()};
const st={...STRATEGY_DEFAULTS,id:'strategy',enabled:true,mode:'team',coin:'BCH',packageName:'Team Silver',teamLevels:[{threshold:5,shares:1},{threshold:25,shares:1}]};
test('request formats validate and survive settings backup/import',()=>{
 assert.equal(purchaseProfile({}),'documented');
 assert.equal(validateSettings({purchaseRequestProfile:'guide'},DEFAULTS).purchaseRequestProfile,'guide');
 assert.throws(()=>validateSettings({purchaseRequestProfile:'bad'},DEFAULTS));
 const backup=configurationBackup({settings:{...DEFAULTS,purchaseRequestProfile:'web'},strategies:[]});
 assert.equal(parseConfigurationBackup(backup).settings.purchaseRequestProfile,'web');
});
test('confirmed failures are scoped to a request format and route',()=>{
 const order={kind:'team',packageId:id,submissionFailure:{rejected:true,httpStatus:404,path:'/main/api/v2/hashpower/shared/ticket/'+id,purchaseRequestProfile:'documented'}};
 assert.ok(rejectedTeamTarget([order],id));assert.ok(!rejectedTeamTarget([order],id,'web'));assert.ok(!rejectedTeamTarget([order],id,'guide'));
 order.submissionFailure={...order.submissionFailure,path:'/hashpower/api/v2/hashpower/shared/ticket/'+id,purchaseRequestProfile:'guide'};
 assert.ok(rejectedTeamTarget([order],id,'guide'));assert.ok(!rejectedTeamTarget([order],id,'web'));
 delete order.submissionFailure.purchaseRequestProfile;
 assert.ok(rejectedTeamTarget([order],id,'guide'));assert.ok(rejectedTeamTarget([order],id,'web'));
});
test('guide format skips owned additions and keeps fresh first joins available',()=>{
 const owned={id:'owned',mode:'paper',kind:'team',packageId:id,strategyId:st.id,status:'PENDING',costBtc:10000,shares:1,createdAt:new Date().toISOString()};
 const fresh={...pkg,id:'55555555-5555-4555-8555-555555555555'};
 assert.equal(pickQuote([pkg],st,[owned],'guide'),null);
 assert.equal(pickQuote([pkg,fresh],st,[owned],'guide').id,fresh.id);
 const state={settings:{...DEFAULTS,running:true,purchaseRequestProfile:'guide'},orders:[owned],rewards:[],runtime:{},packages:[pkg]};
 assert.match(guard(state,st,null),/first joins/);
});
test('ordinary strategy identifies quarantine without needing levels enabled',()=>{
 const strategy={...st,teamLevels:[]},failed={id:'failed',mode:'paper',kind:'team',status:'FAILED',packageId:id,costBtc:10000,createdAt:new Date().toISOString(),submissionFailure:{rejected:true,httpStatus:404,path:'/main/api/v2/hashpower/shared/ticket/'+id}};
 const state={settings:{...DEFAULTS,running:true},orders:[failed],rewards:[],runtime:{},packages:[pkg]};
 assert.equal(pickQuote([pkg],strategy,[failed]),null);assert.match(guard(state,strategy,null),/NiceHash rejected the current team/);
});
test('format UI describes guide limitation and disables unsupported servers',()=>{
 const html=requestProfilePanel({purchaseRequestProfile:'guide'});
 assert.match(html,/First joins only/);assert.match(html,/amount and clear omitted/);assert.match(html,/pauses the engine/);
 const unsupported=requestProfilePanel({}, {supported:false,serverVersion:'<script>bad</script>'});
 assert.match(unsupported,/needs updating/);assert.ok(!unsupported.includes('<script>'));assert.match(unsupported,/id="purchaseRequestProfile"[^>]*disabled/);
});
