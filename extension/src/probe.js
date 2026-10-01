import {PROBE_URL} from './model.js';

export async function probeRequest(signal, timeout = 6000) {
  const started = performance.now();
  const response = await fetch(`${PROBE_URL}?t=${crypto.randomUUID()}`, {
    cache:'no-store', credentials:'omit', redirect:'error',
    signal:AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
  });
  if (response.status !== 204) throw new Error('Probe response rejected');
  return performance.now() - started;
}

export async function measureLatency(signal, request = probeRequest) {
  // The first request establishes proxy auth and TLS; it is not a warm RTT sample.
  const warmupMs = Math.round(await request(signal, 12000));
  const samples = [];
  for (let i=0; i<3; i++) {
    signal.throwIfAborted();
    samples.push(Math.round(await request(signal, 5000)));
  }
  return {ms:[...samples].sort((a,b)=>a-b)[1], samples, warmupMs, method:'warm-http-median'};
}

export async function checkReachability(signal, request = probeRequest, pause = wait) {
  // One event or one failed request is insufficient evidence of a persistent issue.
  for (let attempt=0; attempt<2; attempt++) {
    signal.throwIfAborted();
    try { await request(signal, 6000); return true; }
    catch { signal.throwIfAborted(); }
    if (attempt===0) await pause(1000, signal);
  }
  return false;
}

function wait(ms, signal) {
  return new Promise((resolve,reject)=>{
    signal.throwIfAborted();
    const abort=()=>{clearTimeout(timer);reject(signal.reason);};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
    signal.addEventListener('abort',abort,{once:true});
  });
}
