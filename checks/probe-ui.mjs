import {chromium} from 'playwright';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const ctx=await chromium.launchPersistentContext(resolve('work/probe-ui-profile'),{channel:'chrome',headless:true,ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging']});
let worker;
try{
 const cdp=await ctx.browser().newBrowserCDPSession();
 const {id}=await cdp.send('Extensions.loadUnpacked',{path:resolve('dist/extension')});
 const page=await ctx.newPage();await page.goto(`chrome-extension://${id}/options.html`);
 worker=ctx.serviceWorkers()[0]||await ctx.waitForEvent('serviceworker');
 await worker.evaluate(()=>{
  globalThis.fetch=async(url,opts)=>{
   if(String(url).startsWith('https://subscription.invalid/'))return new Response(JSON.stringify({proxies:[{name:'Fixture',type:'http',server:'proxy.invalid',port:18443,tls:true,username:'fixture',password:'test-only'}]}));
   globalThis.probeStarted=true;
   return new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true}));
  };
 });
 const action=(action,extra={})=>page.evaluate(args=>chrome.runtime.sendMessage(args),{action,...extra});
 await action('refresh',{url:'https://subscription.invalid/test'});await action('select',{id:'proxy.invalid:18443'});await action('connect');
 await page.goto(`chrome-extension://${id}/popup.html`);
 await page.getByText('代理已启用',{exact:true}).waitFor();
 await page.getByRole('button',{name:'测延迟',exact:true}).click();
 await page.getByText('检测中…',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'断开',exact:true}).isEnabled(),true);
 await page.getByRole('button',{name:'断开',exact:true}).click();
 await page.getByText('关闭',{exact:true}).waitFor();
 assert.equal(await page.locator('#latency').textContent(),'未检测');
 assert.equal(await page.locator('#notice').textContent(),'');
 console.log('Probe UI passed: disconnect stays usable while checking; cancelled result cannot overwrite closed state.');
}finally{if(worker)await worker.evaluate(async()=>{await chrome.proxy.settings.clear({scope:'regular'});await chrome.storage.local.clear();await chrome.storage.session.clear();}).catch(()=>{});await ctx.close();}
