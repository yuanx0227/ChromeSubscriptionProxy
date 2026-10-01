// Only this defect: automatic recovery, MV3 suspension, UI updates and cancellation.
// All subscription credentials and probe responses are synthetic; no live server is used.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

await mkdir('work', {recursive:true});
const profile = await mkdtemp(resolve('work/network-recovery-'));
const context = await chromium.launchPersistentContext(profile, {
  channel:'chrome', headless:true, ignoreDefaultArgs:['--disable-extensions'],
  args:['--enable-unsafe-extension-debugging'],
});
let worker;
async function until(check, timeout = 40000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'Automatic recovery timed out');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function inject(mode) {
  await worker.evaluate(mode => {
    globalThis.networkFixture = {mode, requests:0, started:false};
    globalThis.fetch = async (url, {signal} = {}) => {
      if (String(url).startsWith('https://subscription.invalid/')) return new Response(JSON.stringify({proxies:[{
        name:'Recovery fixture', type:'http', server:'fixture.invalid', port:18443, tls:true, username:'fixture', password:'synthetic',
      }]}));
      const fixture = globalThis.networkFixture;
      fixture.requests++;fixture.started=true;
      if (fixture.mode === 'offline') throw new TypeError('Synthetic network outage');
      if (fixture.mode === 'blocked') return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        signal.addEventListener('abort', () => reject(signal.reason), {once:true});
      });
      return new Response(null, {status:204});
    };
  }, mode);
}
try {
  const cdp = await context.browser().newBrowserCDPSession();
  const {id} = await cdp.send('Extensions.loadUnpacked', {path:resolve('dist/extension')});
  let popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await inject('offline');
  await worker.evaluate(async () => {
    await chrome.storage.local.set({routingCheckedAt:Date.now()});
    await chrome.alarms.clear('routing-catchup');
  });
  const action = (action, extra = {}) => popup.evaluate(message => chrome.runtime.sendMessage(message), {action, ...extra});
  assert.equal((await action('refresh', {url:'https://subscription.invalid/fixture'})).ok, true);
  await action('select', {id:'fixture.invalid:18443'});
  await action('connect');
  assert.equal((await action('status')).data.status, '代理已启用');
  await popup.getByRole('button', {name:'测延迟', exact:true}).click();
  await popup.getByText('检测失败', {exact:true}).waitFor();
  assert.match(await popup.locator('#notice').innerText(), /自动重试/);
  assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), '!');
  assert.equal((await worker.evaluate(() => chrome.alarms.get('proxy-recheck'))).periodInMinutes, 0.5);
  await popup.close();
  console.log('Confirmed outage; waiting for the real Chrome alarm with popup closed.');
  await until(() => worker.evaluate(async () => {
    const {proxyHealth} = await chrome.storage.session.get('proxyHealth');
    return networkFixture.requests === 3 && proxyHealth.latency === null && proxyHealth.error.includes('连续两次');
  }));
  assert.equal((await worker.evaluate(() => chrome.alarms.get('proxy-recheck'))).periodInMinutes, 0.5);
  console.log('Automatic check failed twice; the recovery alarm remains scheduled.');

  // Force MV3 suspension during the outage. Recovery must survive loss of JS globals.
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const session = await context.newCDPSession(popup);
  let runningStatus;
  session.on('ServiceWorker.workerVersionUpdated', ({versions}) => {
    const version = versions.find(version => version.scriptURL === `chrome-extension://${id}/background.js`);
    if (version) runningStatus = version.runningStatus;
  });
  await session.send('ServiceWorker.enable');
  await until(() => runningStatus === 'running', 5000);
  await session.send('ServiceWorker.stopAllWorkers');
  await until(() => runningStatus === 'stopped', 5000);
  // Chrome reuses the debugging target across restarts, so Playwright keeps the Worker object.
  await action('status');
  await until(() => runningStatus === 'running', 5000);
  assert.equal(await worker.evaluate(() => typeof globalThis.networkFixture), 'undefined', 'worker globals must have been discarded');
  await inject('online');
  assert.match((await action('status')).data.proxyError, /自动重试/);
  console.log('Worker restarted; network responses now succeed, without clicking a probe.');
  await until(() => worker.evaluate(async () => {
    const {proxyHealth} = await chrome.storage.session.get('proxyHealth');
    return !proxyHealth.error && !proxyHealth.pending && networkFixture.requests > 0;
  }));
  await until(async () => (await popup.locator('#notice').innerText()) === '');
  assert.equal(await popup.locator('#latency').innerText(), '未检测');
  assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), 'ON');
  assert.equal(await worker.evaluate(() => chrome.alarms.get('proxy-recheck')), undefined);
  assert.equal((await action('status')).data.latency, null, 'automatic recovery must not invent a latency measurement');

  // Disconnect remains responsive during a request, and its late result cannot restore ON.
  await inject('blocked');
  const inProgress = action('probe');
  await until(() => worker.evaluate(() => networkFixture.started), 5000);
  const disconnected = await action('disconnect');
  assert.equal(disconnected.data.enabled, false);
  await inProgress;
  assert.equal(await worker.evaluate(() => chrome.alarms.get('proxy-recheck')), undefined);
  assert.equal(await worker.evaluate(() => chrome.action.getBadgeText({})), '');
  assert.equal((await action('status')).data.proxyError, '');
  const evidence = {
    version:'0.3.6', syntheticNetwork:true, realChromeAlarms:true, retrySeconds:30,
    retriesWithPopupClosed:true, consecutiveAutomaticFailures:2,
    resumesAfterWorkerSuspension:true, recoveryWithoutManualProbe:true,
    clearsWarningAndBadge:true, stopsAlarmOnSuccess:true, disconnectCancelsProbe:true,
  };
  await writeFile('work/network-recovery-result.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  if (worker) await worker.evaluate(async () => {
    await chrome.proxy.settings.clear({scope:'regular'});
    await chrome.storage.local.clear();await chrome.storage.session.clear();
  }).catch(() => {});
  await context.close();
}
