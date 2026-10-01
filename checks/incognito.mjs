// Local-only HTTPS proxy fixture. Tests real Chrome incognito, PAC and 407 callbacks.
// TLS certificate exceptions apply only to this disposable automation profile.
import {chromium} from 'playwright';
import {createServer as createHttpsServer} from 'node:https';
import {createServer} from 'node:http';
import {readFile, mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';

await mkdir('work',{recursive:true});
const profile=await mkdtemp(resolve('work/incognito-check-'));
let challenges=0,authenticated=0,directHits=0;
const proxy=createHttpsServer({key:await readFile('work/incognito-tls/key.pem'),cert:await readFile('work/incognito-tls/cert.pem')},(request,response)=>{
 if(request.headers['proxy-authorization']!=='Basic '+Buffer.from('fixture:local-only').toString('base64')){
  challenges++;response.writeHead(407,{'Proxy-Authenticate':'Basic realm="incognito-fixture"','Connection':'close'});response.end();return;
 }
 authenticated++;response.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'no-store'});response.end('PROXY_AUTHENTICATED');
});
const direct=createServer((request,response)=>{directHits++;response.writeHead(200,{'Content-Type':'text/plain','Cache-Control':'no-store'});response.end('LOCAL_DIRECT');});
await new Promise(r=>proxy.listen(0,'127.0.0.1',r));await new Promise(r=>direct.listen(0,'127.0.0.1',r));
const port=proxy.address().port, directPort=direct.address().port;
let ctx,worker;
try{
 ctx=await chromium.launchPersistentContext(profile,{channel:'chrome',headless:true,ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging','--ignore-certificate-errors','--disable-background-networking']});
 const cdp=await ctx.browser().newBrowserCDPSession();
 const management=await ctx.newPage();await management.goto('chrome://extensions/');
 await management.getByRole('button',{name:'开发者模式',exact:true}).click();
 const {id}=await cdp.send('Extensions.loadUnpacked',{path:resolve('dist/extension')});
 await management.goto(`chrome://extensions/?id=${id}`);
 const toggle=management.locator('extensions-detail-view #allow-incognito cr-toggle');
 await toggle.waitFor({state:'visible'});
 await toggle.click();
 assert.equal(await toggle.evaluate(element=>element.checked),true);
 const settings=await ctx.newPage();
 // Chrome reloads the extension when the incognito permission changes.
 for(let attempt=0;;attempt++){
  try{await settings.goto(`chrome-extension://${id}/options.html`);break;}
  catch(error){if(attempt>=10)throw error;await new Promise(r=>setTimeout(r,200));}
 }
 worker=ctx.serviceWorkers()[0]||await ctx.waitForEvent('serviceworker');
 assert.equal(await worker.evaluate(()=>chrome.extension.isAllowedIncognitoAccess()),true);
 await worker.evaluate(port=>{
  const actual=globalThis.fetch;
  globalThis.fetch=(url,options)=>String(url)==='https://subscription.example.invalid/fixture'?Promise.resolve(new Response(JSON.stringify({proxies:[{name:'Incognito fixture',type:'http',tls:true,server:'127.0.0.1',port,username:'fixture',password:'local-only'}]}))):actual(url,options);
 },port);
 const action=(action,extra={})=>settings.evaluate(args=>chrome.runtime.sendMessage(args),{action,...extra});
 assert.equal((await action('refresh',{url:'https://subscription.example.invalid/fixture'})).ok,true);
 await action('select',{id:`127.0.0.1:${port}`});
 assert.equal((await action('connect')).data.status,'代理已启用');
 const regular=await ctx.newPage();await regular.goto('http://ordinary.example.test/check',{waitUntil:'domcontentloaded',timeout:15000});
 assert.equal(await regular.locator('body').innerText(),'PROXY_AUTHENTICATED');
 // CDP creates a genuine off-the-record context; no proxy setting is supplied by Playwright.
 const {browserContextId}=await cdp.send('Target.createBrowserContext');
 const {targetId}=await cdp.send('Target.createTarget',{url:'about:blank',browserContextId});
 const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:false});
 let sequence=0; const pending=new Map();
 cdp.on('Target.receivedMessageFromTarget',event=>{if(event.sessionId!==sessionId)return;const m=JSON.parse(event.message);if(pending.has(m.id)){const {resolve,reject}=pending.get(m.id);pending.delete(m.id);m.error?reject(new Error(m.error.message)):resolve(m.result);}});
 async function offRecord(method,params={}){
  const id=++sequence;
  const promise=new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));
  await cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})});
  return Promise.race([promise,new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('Off-record operation timeout: '+method)),15000);t.unref();})]);
 }
 await offRecord('Page.enable');
 async function navigate(url,expected){
  await offRecord('Page.navigate',{url});
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){
   const r=await offRecord('Runtime.evaluate',{expression:'document.body?.innerText',returnByValue:true});
   if(r.result.value===expected)return;
   await new Promise(r=>setTimeout(r,100));
  }
  throw new Error('Incognito page did not produce expected fixture response');
 }
 const before={challenges,authenticated};
 await navigate('http://private.example.test/check','PROXY_AUTHENTICATED');
 assert.ok(authenticated>before.authenticated,'Incognito must use the configured HTTPS proxy');
 assert.ok(challenges>before.challenges,'Incognito must answer a fresh 407 challenge');
 const privateConfig=await worker.evaluate(()=>chrome.proxy.settings.get({incognito:true}));
 assert.equal(privateConfig.value.mode,'pac_script');
 assert.equal(privateConfig.incognitoSpecific,false);
 const beforeDirect=authenticated;
 await navigate(`http://127.0.0.1:${directPort}/check`,'LOCAL_DIRECT');
 assert.ok(directHits>0);assert.equal(authenticated,beforeDirect);
 await action('disconnect');
 assert.notEqual((await worker.evaluate(()=>chrome.proxy.settings.get({incognito:true}))).levelOfControl,'controlled_by_this_extension');
 await cdp.send('Target.disposeBrowserContext',{browserContextId});
 const evidence={passed:true,allowIncognitoToggle:true,regularProxyAuth:true,incognitoFreshProxyAuth:true,sharedPac:true,privateNetworkDirect:true,disconnectReleasesIncognito:true,proxyChallenges:challenges,authenticatedRequests:authenticated,usesLocalFixturesOnly:true};
 await writeFile('work/incognito-result.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{
 if(worker)await worker.evaluate(async()=>{await chrome.proxy.settings.clear({scope:'regular'});await chrome.storage.local.clear();}).catch(()=>{});
 if(ctx)await ctx.close();
 proxy.closeAllConnections();direct.closeAllConnections();
 await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>direct.close(r))]);
}
