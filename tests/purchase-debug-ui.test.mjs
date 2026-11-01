import test from 'node:test';
import assert from 'node:assert/strict';
import {debugPanel,debugTraceOptions,debugTraceView} from '../public/purchase-debug.mjs';

test('debug controls distinguish server capture from preview and show retention',()=>{
  const html=debugPanel({enabled:true,expiresAt:'2026-10-28T13:30:00Z',traceCount:2,traceLimit:50},false,'Europe/Sofia');
  assert.match(html,/Stop capture/);assert.match(html,/View traces · 2/);assert.match(html,/15:30:00/);assert.match(html,/does not start or arm/);
  assert.match(debugPanel({},true),/data-action="debug-enable" disabled/);
  assert.match(debugPanel({},false),/data-action="debug-view" disabled/);
});
test('trace rendering escapes provider messages, metadata and option values',()=>{
  const trace={id:'<img src=x onerror=alert(1)>',startedAt:'2026-10-28T12:00:00Z',source:'<script>bad</script>',outcome:'rejected',purchasePostCount:1,events:[{at:'2026-10-28T12:00:00Z',elapsedMs:12,stage:'http_response',details:{message:'</pre><img src=x onerror=alert(1)>',httpStatus:404}}]};
  const html=debugTraceView(trace,'Europe/Sofia');
  assert.ok(!html.includes('<script>')&&!html.includes('<img'));
  assert.ok(html.includes('&lt;img')&&html.includes('http response')&&html.includes('404'));
  assert.ok(!debugTraceOptions([trace],'Europe/Sofia').includes('<img'));
});
