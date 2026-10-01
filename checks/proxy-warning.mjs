// Focused checks for event confirmation, cold measurements and stale async results.
import {build} from 'esbuild';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {measureLatency,checkReachability} from '../extension/src/probe.js';
const controller=new AbortController();
const times=[1442,171,800,173];
const measured=await measureLatency(controller.signal,async()=>times.shift());
assert.deepEqual(measured,{ms:173,samples:[171,800,173],warmupMs:1442,method:'warm-http-median'});
let attempts=0;
assert.equal(await checkReachability(controller.signal,async()=>{if(++attempts===1)throw Error();},async()=>{}),true);
assert.equal(attempts,2);
assert.equal(await checkReachability(controller.signal,async()=>{throw Error();},async()=>{}),false);
const bundled=await build({entryPoints:['extension/src/background.js'],bundle:true,write:false,format:'iife',platform:'browser'});
const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn);}});
const onProxyError=event(),onMessage=event(),sessions={};
const node={id:'fixture.invalid:18443',name:'Fixture',host:'fixture.invalid',port:18443,username:'fixture',password:'synthetic'};
const store={config:{schema:1,subscriptionUrl:'https://subscription.invalid/test',nodes:[node],unsupported:[],selectedId:node.id,enabled:true,rules:{proxy:[],direct:[]},proxyError:'正在检查代理…',proxyErrorFatal:true}};
let settings={levelOfControl:'controllable_by_this_extension',value:{mode:'system'}},badge='',setCount=0,requestCount=0,clock=0;
let fetcher=async()=>{clock+=170;return {status:204};};
const alarms=new Map();
const chrome={storage:{local:{setAccessLevel:async()=>{},get:async()=>structuredClone(store),set:async value=>Object.assign(store,structuredClone(value))},session:{get:async()=>structuredClone(sessions),set:async value=>Object.assign(sessions,structuredClone(value))}},
 action:{setBadgeText:async value=>{badge=value.text;},setBadgeBackgroundColor:async()=>{}},
 proxy:{onProxyError,settings:{get:async()=>structuredClone(settings),set:async({value})=>{setCount++;settings={levelOfControl:'controlled_by_this_extension',value};},clear:async()=>{settings={levelOfControl:'controllable_by_this_extension',value:{mode:'system'}};},onChange:event()}},
 webRequest:{onAuthRequired:event(),onCompleted:event(),onErrorOccurred:event()},
 runtime:{id:'fixture',getURL:path=>'chrome-extension://fixture/'+path,onMessage,onStartup:event()},
 alarms:{get:async name=>alarms.get(name),create:async(name,options)=>alarms.set(name,options),clear:async name=>alarms.delete(name),onAlarm:event()}};
vm.runInNewContext(bundled.outputFiles[0].text,{chrome,structuredClone,URL,TextEncoder,TextDecoder,Date,performance:{now:()=>clock},crypto:webcrypto,AbortSignal,AbortController,setTimeout,clearTimeout,fetch:(...args)=>{requestCount++;return fetcher(...args);},console});
const action=(action,extra={})=>new Promise(resolve=>onMessage.listeners[0]({action,...extra},{id:'fixture',url:'chrome-extension://fixture/popup.html'},resolve));
const emit=fatal=>onProxyError.listeners[0]({fatal,error:'ERR_PROXY_CONNECTION_FAILED'});
async function until(predicate){const end=Date.now()+5000;while(!predicate()){assert.ok(Date.now()<end,'Timed out');await new Promise(r=>setTimeout(r,5));}}
let result=await action('status');assert.equal(result.data.proxyError,'','old pending warning must not survive browser restart');
const originalSets=setCount;await action('connect');assert.equal(setCount,originalSets);
emit(false);await action('status');assert.equal(alarms.has('proxy-recheck'),false);
emit(true);emit(true);result=await action('status');
assert.equal(result.data.proxyError,'','unconfirmed events must not show a warning');assert.equal(badge,'ON');
assert.equal(sessions.proxyHealth.pending,true);
await until(()=>sessions.proxyHealth.pending===false&&requestCount>0);
await until(()=>badge==='ON');result=await action('status');assert.equal(result.data.proxyError,'');assert.equal(result.data.latency,null);
await new Promise(r=>setTimeout(r,3));let failures=0;
fetcher=async()=>{failures++;emit(true);throw Error('Synthetic endpoint failure');};
emit(true);await action('status');
await until(()=>sessions.proxyHealth.error?.includes('连续两次'));
assert.equal(failures,2);assert.equal(badge,'!');assert.equal(alarms.get('proxy-recheck').periodInMinutes,0.5);
const sampleTimes=[1442,171,173,172];fetcher=async()=>{clock+=sampleTimes.shift();return {status:204};};
result=await action('probe');assert.equal(result.ok,true);assert.equal(result.data.latency.ms,172);assert.equal(result.data.latency.warmupMs,1442);assert.equal(result.data.proxyError,'');assert.equal(badge,'ON');
assert.equal(store.config.proxyError,'');assert.equal(store.config.latency,null,'latency only belongs to this browser session');
assert.equal(alarms.has('proxy-recheck'),false,'successful probe stops automatic recovery checks');
let started,release;
const ready=new Promise(r=>started=r);
fetcher=async(_url,{signal})=>{started();return new Promise((resolve,reject)=>{release=()=>resolve({status:204});signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});};
const inProgress=action('probe');await ready;
result=await action('disconnect');assert.equal(result.data.enabled,false,'disconnect must not wait for network probe');
release();await inProgress;result=await action('status');assert.equal(result.data.latency,null);assert.equal(result.data.proxyError,'');assert.equal(badge,'');
console.log('Passed: cold warmup excluded, median resists outlier, silent startup verification, two failures to warn, no recursive event loop, recovery alarm until success, session-only health, duplicate PAC avoided, disconnect cancels stale probe.');
