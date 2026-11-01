import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULTS,STRATEGY_DEFAULTS,pickQuote,guard} from '../public/core.mjs';
import {isTeamStateRejection,rejectedTeamTarget,rejectedTeamReason,isUnavailableTeam,TEAM_STATE_REJECTED_REASON} from '../public/purchase-status.mjs';

const id='d5839c67-942a-44fb-be83-16ea5633a191';
const other='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const failure={rejected:true,uncertain:false,httpStatus:400,code:5251,method:'POST',path:'/hashpower/api/v2/hashpower/shared/ticket/'+id,purchaseRequestProfile:'web'};
const order={id:'attempt',kind:'team',packageId:id,status:'FAILED',mode:'live',submissionFailure:failure};
const pkg={id,coin:'BCH',name:'Team Silver',team:true,market:'BTC',available:true,teamShares:68,costBtc:10000,quotedAt:new Date().toISOString()};
const strategy={...STRATEGY_DEFAULTS,id:'strategy',enabled:true,mode:'team',coin:'BCH',packageName:'Team Silver'};

test('only a definitive team POST HTTP 400 code 5251 is a state rejection',()=>{
 for(const code of [5251,'5251'])assert.ok(isTeamStateRejection({...failure,code}));
 for(const patch of [{uncertain:true},{rejected:false},{httpStatus:500},{httpStatus:401},{code:5252},{method:'GET'},{path:'/hashpower/api/v2/hashpower/solo/order'},{path:failure.path+'/extra'},{path:failure.path.replace(id,'invalid')},{path:failure.path.replace('/hashpower/','/other/')}])assert.ok(!isTeamStateRejection({...failure,...patch}));
 assert.ok(isUnavailableTeam(order));
});
test('retained state rejection excludes only its team across every explicit format',()=>{
 for(const profile of ['documented','web','guide']){
  assert.ok(rejectedTeamTarget([order],id,profile));
  assert.equal(rejectedTeamReason([order],id,profile),TEAM_STATE_REJECTED_REASON);
  assert.ok(!rejectedTeamTarget([order],other,profile));
 }
});
test('failed additions and pre-upgrade failures keep state rejection evidence',()=>{
 for(const record of [{...order,submissionFailure:undefined,lastTeamPurchaseFailure:{...failure,purchaseRequestProfile:undefined}}, {...order,submissionFailure:undefined,teamBuys:[{status:'FAILED',failure}]}])assert.ok(rejectedTeamTarget([record],id));
});
test('ordinary and level strategies select a different team and report the real wait reason',()=>{
 const now=Date.now();
 for(const teamLevels of [[],[{threshold:5,shares:1},{threshold:25,shares:1}]]){
  const st={...strategy,teamLevels};
  const state={settings:{...DEFAULTS,mode:'live',running:true,liveArmed:true,purchaseRequestProfile:'web'},runtime:{lastSync:new Date(now).toISOString(),historyComplete:true,errors:0,balance:2000000},orders:[order],rewards:[],packages:[pkg]};
  assert.equal(pickQuote([pkg],st,[order],'web'),null);
  assert.equal(guard(state,st,null,now),TEAM_STATE_REJECTED_REASON);
  assert.equal(guard(state,st,pkg,now),TEAM_STATE_REJECTED_REASON);
  assert.equal(pickQuote([pkg,{...pkg,id:other}],st,[order],'web').id,other);
 }
});
test('state exclusions do not bypass unknown purchase reservations',()=>{
 const unknown={...order,id:'unknown',packageId:other,status:'UNKNOWN',submissionFailure:{...failure,uncertain:true,rejected:false}};
 const state={settings:{...DEFAULTS,mode:'live',running:true,liveArmed:true,purchaseRequestProfile:'web'},runtime:{lastSync:new Date().toISOString(),historyComplete:true,errors:0,balance:2000000},orders:[order,unknown],rewards:[],packages:[pkg,{...pkg,id:other}]};
 assert.match(guard(state,strategy,{...pkg,id:other}),/Unresolved purchase/);
});
