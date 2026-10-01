// Authorized real-server acceptance. Credentials arrive over stdin, never from source files.
import {chromium} from 'playwright';
import {resolve} from 'node:path';
import {writeFile, mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString());
const launch = () => chromium.launchPersistentContext(resolve('work/chrome-live-profile'), {channel: 'chrome', headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging']});
let context = await launch();
let page, worker, stage='launch';
const results = [];
try {
  const cdp = await context.browser().newBrowserCDPSession();
  const {id} = await cdp.send('Extensions.loadUnpacked', {path: resolve('dist/extension')});
  page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  async function action(action, values = {}) {
    return page.evaluate(({action, values}) => chrome.runtime.sendMessage({action, ...values}), {action, values});
  }
  async function traffic() {
    const result = [];
    for (const email of input.panel.emails) {
      const response = await fetch(input.panel.base+'/panel/api/clients/traffic/'+encodeURIComponent(email), {headers:{Authorization:'Bearer '+input.panel.token},signal:AbortSignal.timeout(10000)});
      const body = await response.json();
      assert.equal(body.success,true,'Live traffic API failed');
      const rows = Array.isArray(body.obj) ? body.obj : [body.obj];
      assert.ok(rows.every(x => x && typeof x.up==='number' && typeof x.down==='number'), 'Live traffic API shape mismatch');
      result.push(rows.reduce((sum,x)=>sum+x.up+x.down,0));
    }
    return result;
  }
  for (let index = 0; index < input.subscriptions.length; index++) {
    stage='account-'+index;
    const before = await traffic();
    const refreshed = await action('refresh', {url: input.subscriptions[index]});
    assert.equal(refreshed.ok, true, 'Live subscription import failed');
    assert.equal(refreshed.data.nodes.length, 1);
    assert.equal(refreshed.data.nodes[0].port, input.expectedPorts[index]);
    assert.equal((await action('select', {id: refreshed.data.nodes[0].id})).ok, true);
    const connected = await action('connect');
    assert.equal(connected.data.status, '代理已启用');
    const probe = await action('probe');
    assert.equal(probe.data.latency?.ok, true, 'Live proxy latency request failed');
    const trace = await page.evaluate(async () => {
      const response = await fetch('https://www.cloudflare.com/cdn-cgi/trace?t='+crypto.randomUUID(), {cache:'no-store', signal:AbortSignal.timeout(15000)});
      const body = await response.text();
      return {status:response.status, ip:body.match(/^ip=(.*)$/m)?.[1]};
    });
    assert.equal(trace.status, 200); assert.equal(trace.ip, input.expectedIp, 'Unexpected egress IP');
    let after, matched=false;
    for(let attempt=0;attempt<18;attempt++) {
      after=await traffic();
      if(after[index]>before[index]) {matched=true;break;}
      await new Promise(r=>setTimeout(r,2000));
    }
    assert.ok(matched,'Live panel accounting did not increase');
    assert.equal(after[1-index],before[1-index],'Live traffic charged to the other test user');
    results.push({index, port:input.expectedPorts[index], imported:true, proxyRequestMs:probe.data.latency.ms, serverEgressConfirmed:true, panelBytesAdded:after[index]-before[index], otherTestUserBytesAdded:after[1-index]-before[1-index]});
    console.log(JSON.stringify(results.at(-1)));
  }
  await context.close();
  stage='restart-load';
  context=await launch();
  const resumedCdp=await context.browser().newBrowserCDPSession();
  await resumedCdp.send('Extensions.loadUnpacked',{path:resolve('dist/extension')});
  page=await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  stage='restart-state';
  worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const restored=await action('status');
  assert.equal(restored.data.status,'代理已启用','Live connection state did not restore');
  assert.equal((await action('probe')).data.latency.ok,true,'Live restored proxy request failed');
  console.log(JSON.stringify({restartRestored:true}));
  await action('disconnect');
  await worker.evaluate(async () => { await chrome.proxy.settings.clear({scope:'regular'}); await chrome.storage.local.clear(); });
  await mkdir('work', {recursive:true});
  await writeFile('work/chrome-live-result.json', JSON.stringify({passed:true, results, restartRestored:true}, null, 2));
} catch(e) {
  console.log(JSON.stringify({passed:false, reason:e.name, stage, code:e.message?.match(/ERR_[A-Z_]+/)?.[0], check:e.message?.startsWith('Live ') || e.message?.startsWith('Unexpected ') ? e.message.split('\n')[0] : 'Assertion or browser operation failed'}));
  process.exitCode = 1;
} finally {
  if (worker) await worker.evaluate(async () => { await chrome.proxy.settings.clear({scope:'regular'}); await chrome.storage.local.clear(); }).catch(()=>{});
  await context.close();
}
