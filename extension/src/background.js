import {parseSubscription, subscriptionURL, normalizeRules, readLimited} from './model.js';
import {buildPAC} from './pac.js';
import bundledRouting from './routing-data.json';
import {fetchRouting, validateRouting, ROUTING_INTERVAL} from './routing.js';
import {measureLatency, checkReachability} from './probe.js';

const initial = {schema: 1, connectionRevision:0, subscriptionUrl: '', nodes: [], unsupported: [], selectedId: null, enabled: false, rules: {proxy: [], direct: []}, updatedAt: null, updateError: '', applyError: '', proxyError: '', latency: null};
let state, expectedPAC = '', serial = Promise.resolve(), routingData = bundledRouting, routingCheckedAt = 0, routingError = '';
let lastSuccessfulProbeAt = 0;
let activeProbe = null, healthPending = false, recheckTimer;
const attempts = new Map();
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  const saved = (await chrome.storage.local.get('config')).config;
  if (saved && saved.schema !== 1) throw new Error('配置版本不受支持');
  state = saved ? {...initial, ...saved} : structuredClone(initial);
  // Runtime health is scoped to the browser session, not persisted across restarts.
  state.proxyError = ''; state.proxyErrorFatal = false; state.latency = null;
  const health = (await chrome.storage.session.get('proxyHealth')).proxyHealth;
  if (health?.revision === state.connectionRevision) {
    state.proxyError = health.error || ''; state.latency = health.latency || null;
    healthPending = health.pending === true || !!state.proxyError || state.latency?.ok === false;
    lastSuccessfulProbeAt = health.lastSuccess || 0;
  }
  const cached = await chrome.storage.local.get(['routingCache', 'routingCheckedAt', 'routingError']);
  if (cached.routingCache) {
    try { routingData = validateRouting(cached.routingCache); buildPAC(state, routingData); }
    catch { routingData = bundledRouting; }
  }
  routingCheckedAt = cached.routingCheckedAt || 0;
  routingError = cached.routingError || '';
})();
function queue(fn) {
  const result = serial.then(() => ready).then(fn);
  serial = result.catch(() => {});
  return result;
}
async function saveHealth() {
  await chrome.storage.session.set({proxyHealth:{revision:state.connectionRevision,error:state.proxyError,latency:state.latency,pending:healthPending,running:activeProbe?.manual===true,lastSuccess:lastSuccessfulProbeAt}});
}
async function save() {
  await chrome.storage.local.set({config:{...state,proxyError:'',proxyErrorFatal:false,latency:null}});
  await saveHealth();
}
function invalidateProbe() {
  state.connectionRevision++;
  activeProbe?.controller.abort(); activeProbe=null;
  clearTimeout(recheckTimer); healthPending=false;
  state.proxyError='';state.proxyErrorFatal=false;state.latency=null;
  lastSuccessfulProbeAt=0;
  void chrome.alarms.clear('proxy-recheck');
}
async function proxySettings() { return chrome.proxy.settings.get({incognito: false}); }
async function badge(text, color = '#2563eb') {
  await chrome.action.setBadgeText({text});
  await chrome.action.setBadgeBackgroundColor({color});
}
async function apply() {
  const current = await proxySettings();
  if (!['controllable_by_this_extension', 'controlled_by_this_extension'].includes(current.levelOfControl)) {
    state.applyError = '代理设置由其他扩展或浏览器策略控制';
    await badge('!', '#b45309'); await save(); return;
  }
  if (!state.enabled) {
    await chrome.proxy.settings.clear({scope: 'regular'});
    expectedPAC = ''; state.applyError = ''; state.proxyError = ''; await badge(''); await save(); return;
  }
  const nextPAC = buildPAC(state, routingData);
  if (expectedPAC && expectedPAC !== nextPAC) invalidateProbe();
  expectedPAC = nextPAC;
  try {
    if (current.levelOfControl !== 'controlled_by_this_extension' || current.value?.pacScript?.data !== expectedPAC)
      await chrome.proxy.settings.set({value: {mode: 'pac_script', pacScript: {data: expectedPAC, mandatory: true}}, scope: 'regular'});
    const applied = await proxySettings();
    if (applied.levelOfControl !== 'controlled_by_this_extension' || applied.value?.pacScript?.data !== expectedPAC)
      throw new Error();
    state.applyError = '';
    await badge(state.nodes.some(n => n.id === state.selectedId) && !state.proxyError ? 'ON' : '!', state.proxyError ? '#b45309' : '#2563eb');
  } catch {
    state.applyError = '代理配置应用失败，请检查 Chrome 的代理策略';
    await badge('!', '#b91c1c');
  }
  await save();
}
async function publicState() {
  const current = await proxySettings();
  let status = '关闭';
  if (state.enabled) {
    if (!['controllable_by_this_extension', 'controlled_by_this_extension'].includes(current.levelOfControl)) status = '代理控制冲突';
    else if (state.applyError || current.levelOfControl !== 'controlled_by_this_extension' || current.value?.pacScript?.data !== (expectedPAC || buildPAC(state, routingData))) status = '配置失败';
    else if (!state.nodes.some(n => n.id === state.selectedId)) status = '当前节点已被移除';
    else status = '代理已启用';
  }
  return {...state, nodes: state.nodes.map(({username, password, ...node}) => node), status, probeRunning:activeProbe?.manual === true, routing: {...routingData.metadata, checkedAt:routingCheckedAt, error:routingError}};
}

async function ensureHealthAlarm() {
  const alarm = await chrome.alarms.get('proxy-recheck');
  if (alarm?.periodInMinutes !== 0.5)
    await chrome.alarms.create('proxy-recheck', {delayInMinutes:0.5, periodInMinutes:0.5});
}
async function scheduleHealthCheck() {
  if (activeProbe || healthPending) return;
  healthPending=true;
  await saveHealth();
  await ensureHealthAlarm();
  armHealthCheck();
}
function armHealthCheck() {
  clearTimeout(recheckTimer);
  // Confirm the first error soon; the alarm covers suspension and later recovery.
  recheckTimer=setTimeout(()=>{if(healthPending)void runProbe(false).catch(()=>{});},1000);
}
async function runProbe(manual) {
  await ready;
  if (activeProbe && (!manual || activeProbe.manual)) {await activeProbe.promise;return queue(publicState);}
  activeProbe?.controller.abort();
  const ticket={revision:state.connectionRevision,nodeId:state.selectedId,controller:new AbortController(),manual};
  activeProbe=ticket;
  ticket.promise=(async()=>{
    await queue(async()=>{
      if(activeProbe!==ticket || ticket.revision!==state.connectionRevision) throw new Error('检测已取消');
      if ((await publicState()).status!=='代理已启用') throw new Error('请先启用有效节点');
      // Keep a recurring alarm until success, including while a probe is in flight.
      // MV3 suspension must not discard the only path to automatic recovery.
      healthPending=true;clearTimeout(recheckTimer);await ensureHealthAlarm();
      await saveHealth();
    });
    let result,ok=false;
    try {
      if(manual){result=await measureLatency(ticket.controller.signal);ok=true;}
      else ok=await checkReachability(ticket.controller.signal);
    } catch {if(ticket.controller.signal.aborted)return;}
    await queue(async()=>{
      if(activeProbe!==ticket || ticket.revision!==state.connectionRevision || (await publicState()).status!=='代理已启用')return;
      if(ok){
        lastSuccessfulProbeAt=Date.now();state.proxyError='';state.proxyErrorFatal=false;
        if(manual)state.latency={ok:true,...result,at:Date.now(),nodeId:ticket.nodeId};
        else if(state.latency?.ok === false)state.latency=null;
        healthPending=false;await chrome.alarms.clear('proxy-recheck');
        await badge('ON');
      }else{
        if(manual)state.latency={ok:false,at:Date.now(),nodeId:ticket.nodeId};
        else state.latency=null;
        state.proxyError=manual ? '检测地址暂时无法访问，正在自动重试' : '检测地址连续两次未响应，正在自动重试';
        await badge('!', '#b45309');
      }
      await saveHealth();
    });
  })().finally(()=>queue(async()=>{
    if(activeProbe!==ticket)return;
    activeProbe=null;
    if ((await publicState()).status !== '代理已启用') {
      healthPending=false;clearTimeout(recheckTimer);await chrome.alarms.clear('proxy-recheck');
    }
    await saveHealth();
  }));
  await ticket.promise;
  return queue(publicState);
}
async function refreshRouting() {
  let previousSettings, changedPAC=false;
  const previousData=routingData, previousExpected=expectedPAC;
  try {
    const candidate=await fetchRouting();
    const candidatePAC=buildPAC(state,candidate);
    previousSettings=await proxySettings();
    if (state.enabled && ['controlled_by_this_extension','controllable_by_this_extension'].includes(previousSettings.levelOfControl)) {
      if(previousSettings.value?.pacScript?.data!==candidatePAC)invalidateProbe();
      await chrome.proxy.settings.set({value:{mode:'pac_script',pacScript:{data:candidatePAC,mandatory:true}},scope:'regular'});
      changedPAC=true;
      const applied=await proxySettings();
      if(applied.levelOfControl!=='controlled_by_this_extension' || applied.value?.pacScript?.data!==candidatePAC) throw new Error();
    }
    const checked=Date.now();
    await chrome.storage.local.set({routingCache:candidate,routingCheckedAt:checked,routingError:''});
    routingData=candidate; routingCheckedAt=checked; routingError='';
    if(changedPAC) expectedPAC=candidatePAC;
    await save();
  } catch {
    routingData=previousData; expectedPAC=previousExpected;
    if(changedPAC && (await proxySettings()).levelOfControl==='controlled_by_this_extension') {
      await chrome.proxy.settings.set({value:previousSettings.levelOfControl==='controlled_by_this_extension' ? previousSettings.value : {mode:'pac_script',pacScript:{data:buildPAC(state,previousData),mandatory:true}},scope:'regular'});
    }
    routingError='规则更新失败，继续使用上次规则';
    await chrome.storage.local.set({routingError});
  }
}
async function refresh(value) {
  const url = subscriptionURL(value || state.subscriptionUrl);
  let result;
  try {
    const response = await fetch(url, {cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(20000)});
    result = parseSubscription(await readLimited(response));
  } catch {
    state.updateError = '订阅更新失败：请检查 HTTPS 地址、网络及 CLASH 格式；继续保留上次有效配置';
    await save(); throw new Error(state.updateError);
  }
  // A valid empty/unsupported export is authoritative; it must revoke a removed selection.
  const changedSource = url !== state.subscriptionUrl;
  invalidateProbe();
  state.subscriptionUrl = url;
  state.nodes = result.nodes; state.unsupported = result.unsupported;
  if (changedSource || !result.nodes.some(n => n.id === state.selectedId)) state.selectedId = null;
  state.updatedAt = Date.now(); state.updateError = ''; state.latency = null;
  attempts.clear(); await save();
  if (state.enabled) await apply();
}

chrome.webRequest.onAuthRequired.addListener((details, callback) => {
  ready.then(() => {
    const host = details.challenger?.host?.toLowerCase().replace(/^\[|\]$/g, '');
    const node = state.enabled && state.nodes.find(n => n.id === state.selectedId);
    if (!details.isProxy || !node || host !== node.host.replace(/^\[|\]$/g, '') || details.challenger.port !== node.port) { callback({}); return; }
    if (attempts.has(details.requestId)) { callback({cancel: true}); return; }
    attempts.set(details.requestId, true);
    callback({authCredentials: {username: node.username, password: node.password}});
  }).catch(() => callback({cancel: true}));
}, {urls: ['<all_urls>']}, ['asyncBlocking']);
for (const event of [chrome.webRequest.onCompleted, chrome.webRequest.onErrorOccurred])
  event.addListener(d => attempts.delete(d.requestId), {urls: ['<all_urls>']});

chrome.proxy.onProxyError.addListener(details => {
  if (activeProbe) return;
  const occurredAt = Date.now();
  const nodeId = state?.selectedId;
  const revision = state?.connectionRevision;
  queue(async () => {
    if (details.fatal !== true || !state.enabled || occurredAt <= lastSuccessfulProbeAt) return;
    if (nodeId !== undefined && nodeId !== state.selectedId) return;
    if (revision !== undefined && revision !== state.connectionRevision) return;
    const current = await proxySettings();
    if (current.levelOfControl !== 'controlled_by_this_extension' || current.value?.pacScript?.data !== expectedPAC) return;
    // An event is a signal to verify, not a user-visible outage or pending warning.
    await scheduleHealthCheck();
  }).catch(() => {});
});
chrome.proxy.settings.onChange.addListener(() => queue(async () => {
  const s = await publicState();
  if (state.enabled && s.status !== '代理已启用') {
    activeProbe?.controller.abort();healthPending=false;clearTimeout(recheckTimer);
    await chrome.alarms.clear('proxy-recheck');await saveHealth();await badge('!', '#b45309');
  } else if (state.enabled && state.proxyError) await scheduleHealthCheck();
}));

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const allowed = ['popup.html', 'options.html'].map(p => chrome.runtime.getURL(p));
  if (sender.id !== chrome.runtime.id || !allowed.includes(sender.url?.split('#')[0])) return;
  if(message?.action==='probe') {
    runProbe(true).then(data=>respond({ok:true,data})).catch(()=>respond({ok:false,error:'无法检测当前节点，请检查连接状态'}));
    return true;
  }
  queue(async () => {
    switch (message?.action) {
      case 'status': break;
      case 'refresh': await refresh(message.url); break;
      case 'refreshRouting': await refreshRouting(); break;
      case 'select':
        if (!state.nodes.some(n => n.id === message.id)) throw new Error('请选择有效节点');
        invalidateProbe();
        state.selectedId = message.id; state.latency = null; attempts.clear(); await save();
        if (state.enabled) await apply();
        break;
      case 'connect':
        if (!state.nodes.some(n => n.id === state.selectedId)) throw new Error('请先导入订阅并选择节点');
        if(!state.enabled)invalidateProbe();
        state.enabled = true; await save(); await apply(); break;
      case 'disconnect':
        invalidateProbe();
        state.enabled = false; state.latency = null; await save();
        // clear removes only our setting, even when another extension currently controls proxy.
        await chrome.proxy.settings.clear({scope: 'regular'});
        expectedPAC = ''; state.applyError = ''; state.proxyError = ''; await save(); await badge(''); break;
      case 'rules':
        const rules = normalizeRules(message.proxy || '', message.direct || '', state.subscriptionUrl ? new URL(state.subscriptionUrl).hostname : '');
        buildPAC({...state, rules}, routingData);
        invalidateProbe();
        state.rules = rules;
        await save(); if (state.enabled) await apply(); break;
      default: throw new Error('未知操作');
    }
    return await publicState();
  }).then(data => respond({ok: true, data})).catch(error => respond({ok: false, error: error.message?.startsWith('订阅') || /^[\u3400-\u9fff]/.test(error.message || '') ? error.message : '操作失败，请重试或检查扩展权限'}));
  return true;
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'proxy-recheck') ready.then(()=>{if(healthPending)return runProbe(false);}).catch(()=>{});
  if (alarm.name === 'subscription-refresh') queue(async () => { if (state.subscriptionUrl) await refresh(); }).catch(() => {});
  if (alarm.name === 'routing-refresh') queue(refreshRouting).catch(() => {});
});
// Also runs when an MV3 worker wakes after suspension; Chrome retains the PAC while suspended.
queue(async () => {
  if (!(await chrome.alarms.get('subscription-refresh')))
    await chrome.alarms.create('subscription-refresh', {periodInMinutes: 1440});
  if (!(await chrome.alarms.get('routing-refresh')))
    await chrome.alarms.create('routing-refresh', {periodInMinutes: 1440});
  if (state.enabled) await apply();
  if(healthPending && (await publicState()).status === '代理已启用') {
    await ensureHealthAlarm();
    // A known outage follows the alarm cadence; an interrupted initial check resumes soon.
    if (!state.proxyError && state.latency?.ok !== false) armHealthCheck();
  } else {
    healthPending=false;await chrome.alarms.clear('proxy-recheck');await saveHealth();
  }
}).catch(() => badge('!', '#b91c1c'));
// Do not block UI initialization on a network request. Recheck shortly after waking.
ready.then(async () => {
  if(Date.now()-routingCheckedAt>ROUTING_INTERVAL && !(await chrome.alarms.get('routing-catchup')))
    await chrome.alarms.create('routing-catchup',{delayInMinutes:1});
});
chrome.alarms.onAlarm.addListener(alarm=>{
  if(alarm.name==='routing-catchup') queue(async()=>{if(Date.now()-routingCheckedAt>ROUTING_INTERVAL) await refreshRouting();}).catch(()=>{});
});
chrome.runtime.onStartup.addListener(() => queue(async () => {
  if (state.enabled) await apply();
  if (state.subscriptionUrl && Date.now() - (state.updatedAt || 0) > 86400000) await refresh();
}).catch(() => {}));
