import {chromium} from 'playwright';
import {resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const chunks=[];for await(const c of process.stdin)chunks.push(c);
const input=JSON.parse(Buffer.concat(chunks).toString());
const launch=()=>chromium.launchPersistentContext(resolve('work/probe-baseline-profile'),{channel:'chrome',headless:true,ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging']});
let ctx=await launch(),worker;
const results=[];
try{
 let cdp=await ctx.browser().newBrowserCDPSession();
 const {id}=await cdp.send('Extensions.loadUnpacked',{path:resolve('dist/extension')});
 let page=await ctx.newPage();await page.goto(`chrome-extension://${id}/options.html`);
 const act=(action,extra={})=>page.evaluate(args=>chrome.runtime.sendMessage(args),{action,...extra});
 let s=await act('refresh',{url:input.subscription});assert.equal(s.ok,true);
 await act('select',{id:s.data.nodes.find(n=>n.port===input.port).id});await act('connect');
 // A new Chrome process has no existing proxy/target TLS connection.
 await ctx.close();ctx=await launch();cdp=await ctx.browser().newBrowserCDPSession();
 await cdp.send('Extensions.loadUnpacked',{path:resolve('dist/extension')});
 page=await ctx.newPage();await page.goto(`chrome-extension://${id}/popup.html`);
 worker=ctx.serviceWorkers()[0]||await ctx.waitForEvent('serviceworker');
 await worker.evaluate(()=>{globalThis.probeEvents=[];chrome.proxy.onProxyError.addListener(d=>globalThis.probeEvents.push({fatal:d.fatal,error:d.error,at:Date.now()}));});
 for(let i=0;i<4;i++){
  s=await act('probe');assert.equal(s.ok,true);assert.equal(s.data.latency.ok,true);
  results.push({index:i,ms:s.data.latency.ms});
 }
 const events=await worker.evaluate(()=>globalThis.probeEvents);
 const report={version:'0.3.4',method:'single HTTPS request per click after Chrome process restart',results,events};
 await writeFile('work/probe-baseline-result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 await act('disconnect');
}finally{if(worker)await worker.evaluate(async()=>{await chrome.proxy.settings.clear({scope:'regular'});await chrome.storage.local.clear();}).catch(()=>{});await ctx.close();}
