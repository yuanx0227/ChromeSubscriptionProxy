// Repeated real Chrome process restarts, same user's authorized subscription, no server writes.
import {chromium} from 'playwright';
import {resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const chunks=[];for await(const c of process.stdin)chunks.push(c);
const input=JSON.parse(Buffer.concat(chunks).toString());
const launch=()=>chromium.launchPersistentContext(resolve('work/probe-fixed-profile'),{channel:'chrome',headless:true,ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging']});
let ctx,worker,page;
const results=[];
const act=(action,extra={})=>page.evaluate(args=>chrome.runtime.sendMessage(args),{action,...extra});
async function load(){
 ctx=await launch();const cdp=await ctx.browser().newBrowserCDPSession();
 const {id}=await cdp.send('Extensions.loadUnpacked',{path:resolve('dist/extension')});
 page=await ctx.newPage();await page.goto(`chrome-extension://${id}/popup.html`);
 worker=ctx.serviceWorkers()[0]||await ctx.waitForEvent('serviceworker');
}
try{
 await load();let s=await act('refresh',{url:input.subscription});assert.equal(s.ok,true);
 await act('select',{id:s.data.nodes.find(n=>n.port===input.port).id});await act('connect');
 for(let restart=0;restart<2;restart++){
  await ctx.close();await load();
  s=await act('status');assert.equal(s.data.status,'代理已启用');assert.equal(s.data.proxyError,'');assert.equal(s.data.latency,null);
  assert.equal(await worker.evaluate(()=>chrome.action.getBadgeText({})),'ON');
  s=await act('probe');assert.equal(s.ok,true);assert.equal(s.data.latency.ok,true);
  const first=s.data.latency;
  assert.equal(first.samples.length,3);assert.equal(first.ms,[...first.samples].sort((a,b)=>a-b)[1]);
  assert.equal(first.method,'warm-http-median');assert.equal(s.data.proxyError,'');
  s=await act('probe');assert.equal(s.data.latency.ok,true);
  results.push({restart:restart+1,startupWarning:false,firstClick:first,secondClick:s.data.latency});
 }
 await act('disconnect');
 const report={version:'0.3.5',realChromeRestarts:2,results};
 await writeFile('work/probe-fixed-result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{
 if(worker)await worker.evaluate(async()=>{await chrome.proxy.settings.clear({scope:'regular'});await chrome.storage.local.clear();await chrome.storage.session.clear();}).catch(()=>{});
 if(ctx)await ctx.close();
}
