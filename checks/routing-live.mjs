// Live public-rule endpoint acceptance in a separate Chrome profile.
import {chromium} from 'playwright';
import {resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {ROUTING_URL,fetchRouting} from '../extension/src/routing.js';
const remote=await fetchRouting();
const ctx=await chromium.launchPersistentContext(resolve('work/routing-live-profile'),{channel:'chrome',headless:true,ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging']});
let worker;
try{
 const cdp=await ctx.browser().newBrowserCDPSession();
 const {id}=await cdp.send('Extensions.loadUnpacked',{path:resolve('dist/extension')});
 const page=await ctx.newPage();await page.goto(`chrome-extension://${id}/options.html`);
 worker=ctx.serviceWorkers()[0]||await ctx.waitForEvent('serviceworker');
 await worker.evaluate(()=>{
  const actual=globalThis.fetch;
  globalThis.fetch=(url,opts)=>String(url)==='https://subscription.example.invalid/fixture'
   ? Promise.resolve(new Response(JSON.stringify({proxies:[{name:'Local acceptance fixture',type:'http',server:'proxy.example.invalid',port:18443,tls:true,username:'fixture',password:'not-a-real-account'}]})))
   :actual(url,opts);
 });
 const action=(action,extra={})=>page.evaluate(args=>chrome.runtime.sendMessage(args),{action,...extra});
 await action('refresh',{url:'https://subscription.example.invalid/fixture'});
 await action('select',{id:'proxy.example.invalid:18443'});
 await action('connect');
 await page.reload();
 await page.locator('#rules-panel>summary').click();
 await page.getByRole('button',{name:'更新规则',exact:true}).click();
 await page.getByText('分流规则已更新',{exact:true}).waitFor({timeout:25000});
 const result=await action('status');assert.equal(result.ok,true);
 assert.equal(result.data.routing.error,'');assert.equal(result.data.status,'代理已启用');
 const cache=await worker.evaluate(()=>chrome.storage.local.get(['routingCache','routingCheckedAt']));
 assert.deepEqual(cache.routingCache.rules,remote.rules);
 assert.equal(cache.routingCache.metadata.fetchedAt,remote.metadata.fetchedAt);
 assert.ok(cache.routingCheckedAt>0);
 const setting=await worker.evaluate(()=>chrome.proxy.settings.get({incognito:false}));
 assert.equal(setting.levelOfControl,'controlled_by_this_extension');
 assert.ok(setting.value.pacScript.data.includes('sourceRules='));
 const alarms=await worker.evaluate(()=>chrome.alarms.getAll());assert.ok(alarms.some(a=>a.name==='routing-refresh'&&a.periodInMinutes===1440));
 const evidence={passed:true,url:ROUTING_URL,ruleCount:remote.rules.length,ipv4Count:remote.ipv4.length,ipv6Count:remote.ipv6.length,sourceBuild:remote.metadata.sourceBuild,serverFetchedAt:remote.metadata.fetchedAt,chromeFetchedAt:new Date(cache.routingCheckedAt).toISOString(),pacBytes:Buffer.byteLength(setting.value.pacScript.data),actualPublicFetch:true,appliedWhileProxyEnabled:true,dailyAlarm:true};
 await writeFile('work/routing-live-result.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
 await action('disconnect');
}finally{
 if(worker)await worker.evaluate(async()=>{await chrome.proxy.settings.clear({scope:'regular'});await chrome.storage.local.clear();}).catch(()=>{});
 await ctx.close();
}
