import {chromium} from 'playwright';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const bundle=JSON.parse(await readFile('extension/src/routing-data.json','utf8'));
const ctx=await chromium.launchPersistentContext(resolve('work/routing-browser-profile'),{channel:'chrome',headless:true,ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging']});
try {
  const cdp=await ctx.browser().newBrowserCDPSession();
  const {id}=await cdp.send('Extensions.loadUnpacked',{path:resolve('dist/extension')});
  const page=await ctx.newPage();await page.goto(`chrome-extension://${id}/options.html`);
  const worker=ctx.serviceWorkers()[0]||await ctx.waitForEvent('serviceworker');
  await worker.evaluate(bundle=>{
    globalThis.routingFixture=bundle;globalThis.routingMode='ok';
    globalThis.fetch=async url=>{
      if(String(url).includes('/qingkong/')) {
        const value=globalThis.routingMode==='invalid'?{schema:99}:globalThis.routingFixture;
        return new Response(JSON.stringify(value),{status:globalThis.routingMode==='failed'?503:200,headers:{'content-type':'application/json'}});
      }
      return new Response(JSON.stringify({proxies:[{name:'Fixture',type:'http',server:'proxy.example.invalid',port:18443,tls:true,username:'fixture',password:'test-only'}]}));
    };
  },bundle);
  const action=(action,extra={})=>page.evaluate(args=>chrome.runtime.sendMessage(args),{action,...extra});
  await action('refresh',{url:'https://subscription.example.invalid/token'});
  await action('select',{id:'proxy.example.invalid:18443'});
  await action('rules',{proxy:'example.com',direct:'direct.example.com'});
  await action('connect');
  const good=await action('refreshRouting');assert.equal(good.ok,true);assert.equal(good.data.routing.error,'');
  const settings=await worker.evaluate(()=>chrome.proxy.settings.get({incognito:false}));
  assert.equal(settings.levelOfControl,'controlled_by_this_extension');
  assert.ok(settings.value.pacScript.data.includes('sourceRules='));
  const cached=await worker.evaluate(()=>chrome.storage.local.get(['routingCache','routingCheckedAt']));
  for(const mode of ['failed','invalid']) {
    await worker.evaluate(mode=>globalThis.routingMode=mode,mode);
    const failed=await action('refreshRouting');assert.match(failed.data.routing.error,/继续使用上次规则/);
    const after=await worker.evaluate(()=>chrome.storage.local.get(['routingCache','routingCheckedAt']));
    assert.deepEqual(after,cached);
    assert.equal((await worker.evaluate(()=>chrome.proxy.settings.get({incognito:false}))).value.pacScript.data,settings.value.pacScript.data);
    assert.deepEqual(failed.data.rules,{proxy:['example.com'],direct:['direct.example.com']});
  }
  const alarms=await worker.evaluate(()=>chrome.alarms.getAll());
  assert.ok(alarms.some(a=>a.name==='routing-refresh'&&a.periodInMinutes===1440));
  await action('disconnect');
  await worker.evaluate(()=>chrome.storage.local.clear());
  console.log('Routing browser checks passed: validated update, actual PAC apply, daily alarm, download/parse failure keeps cache and PAC, custom rules retained.');
} finally {await ctx.close();}
