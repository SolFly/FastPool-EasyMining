import test from 'node:test';
import assert from 'node:assert/strict';
import {telegramPanel,telegramDemoReport} from '../public/telegram.mjs';
import {DEFAULTS,units} from '../public/core.mjs';
import {fundingRecord} from '../public/money.mjs';
import {DemoApi} from '../public/demo.mjs';

test('Telegram settings show masked state without rendering a token or full saved chat',()=>{
 const html=telegramPanel({supported:true,configured:true,enabled:true,tokenConfigured:true,chatLabel:'Saved chat · ••••3210',token:'must-never-render',chatId:'-1009876543210',reportTime:'06:15',threadId:42,lastError:'<script>bad</script>'},{timezone:'Europe/Sofia'});
 assert.match(html,/Telegram notifications/);assert.match(html,/06:15/);assert.match(html,/Europe\/Sofia/);assert.match(html,/value="42"/);assert.match(html,/Saved · leave blank to keep/);
 assert.ok(!html.includes('must-never-render'));assert.ok(!html.includes('-1009876543210'));assert.ok(!html.includes('<script>bad</script>'));assert.match(html,/&lt;script&gt;/);
 assert.match(html,/name="enabled" checked/);assert.match(html,/Send Telegram test/);assert.match(html,/Send yesterday’s report/);
});
test('hosted demo and older servers cannot accept Telegram credentials or submit messages',()=>{
 const demo=telegramPanel({},{demo:true});assert.match(demo,/id="telegram-token"[^>]*disabled/);assert.match(demo,/id="telegram-chat"[^>]*disabled/);assert.match(demo,/does not accept Telegram credentials or send messages/);
 assert.match(demo,/data-action="telegram-test" disabled/);assert.match(demo,/data-action="telegram-report" disabled/);assert.doesNotMatch(demo,/data-action="telegram-preview" disabled/);
 assert.match(telegramPanel(),/Update and restart the Go server/);assert.match(telegramPanel(),/data-action="telegram-preview" disabled/);
});
test('daily demo preview uses the previous Sofia day and keeps native BTC/USDT amounts separate',()=>{
 const at='2026-10-29T10:00:00Z',now=Date.parse('2026-10-30T10:00:00Z');
 const state={settings:DEFAULTS,runtime:{},orders:[{id:'b',mode:'paper',status:'COMPLETED',costBtc:10000,createdAt:at},fundingRecord('USDT',{id:'u',mode:'paper',status:'COMPLETED',costBtc:units('5'),createdAt:at})],rewards:[{id:'r',orderId:'u',coin:'BCH',amount:units('1'),confirmed:true,valueUsdt:units('8'),createdAt:at,confirmedAt:at}]};
 const report=telegramDemoReport(state,now);assert.equal(report.date,'2026-10-29');assert.match(report.text,/ILLUSTRATIVE PAPER PREVIEW/);assert.match(report.text,/Net package spend: 0.00010000 BTC/);assert.match(report.text,/Net package spend: 5.00000000 USDT/);assert.match(report.text,/Net P&L: 3.00000000 USDT/);
});
test('demo API previews reports but rejects every Telegram send and settings mutation',async()=>{
 const api=new DemoApi({settings:DEFAULTS,runtime:{},orders:[],rewards:[]});
 assert.ok((await api.request('/api/telegram/report')).text.includes('ILLUSTRATIVE'));
 for(const path of ['/api/telegram','/api/telegram/test','/api/telegram/report'])await assert.rejects(()=>api.request(path,'POST',{token:'never-store'}),/self-hosted application/);
});
