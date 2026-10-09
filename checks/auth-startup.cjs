// Focused real-Chrome check for automatic proxy authentication and cancellation.
// All TLS endpoints and credentials are local synthetic fixtures.
const {chromium} = require('playwright');
const {createServer} = require('node:https');
const {connect} = require('node:net');
const {readFile, writeFile, mkdir, mkdtemp} = require('node:fs/promises');
const {resolve} = require('node:path');
const assert = require('node:assert/strict');

(async()=>{
  const root=resolve(__dirname,'..');
  const fixture=await mkdtemp(resolve(root,'work/auth-startup-'));
  const tls={key:await readFile(resolve(root,'work/incognito-tls/key.pem')),cert:await readFile(resolve(root,'work/incognito-tls/cert.pem'))};
  const otherPath=resolve(fixture,'other-extension');await mkdir(otherPath);
  await writeFile(resolve(otherPath,'manifest.json'),JSON.stringify({manifest_version:3,name:'Synthetic new tab',version:'1.0',host_permissions:['<all_urls>'],chrome_url_overrides:{newtab:'page.html'}}));
  await writeFile(resolve(otherPath,'page.html'),'<!doctype html><body>PENDING<script src="request.js"></script>');
  await writeFile(resolve(otherPath,'request.js'),"fetch('http://newtab-request.example.test/fixture',{cache:'no-store'}).then(r=>r.text()).then(t=>document.body.textContent=t).catch(()=>document.body.textContent='FAILED');");

  let hold=false, probes=0;
  const held=[],records=[],connections=new Set();
  const origin=createServer(tls,(_,res)=>{
    probes++;
    if(hold){held.push(res);return;}
    res.writeHead(204,{'Cache-Control':'no-store'});res.end();
  });
  await new Promise(r=>origin.listen(0,'127.0.0.1',r));
  const makeProxy=async index=>{
    const expected='Basic '+Buffer.from(`fixture${index}:synthetic-only-${index}`).toString('base64');
    const proxy=createServer(tls,(req,res)=>{
      if(!req.url.startsWith('http://newtab-request.example.test/')){res.writeHead(502);res.end();return;}
      const authorized=req.headers['proxy-authorization']===expected;
      records.push({index,kind:'http',authorized});
      if(!authorized){res.writeHead(407,{'Proxy-Authenticate':'Basic realm="startup-fixture"','Connection':'close'});res.end();return;}
      res.writeHead(200,{'Content-Type':'text/plain','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'});res.end('AUTHENTICATED');
    });
    proxy.on('connect',(req,socket,head)=>{
      // Chrome can still issue internal background requests. Reject them
      // locally so they cannot populate the cache under test or leave localhost.
      if(req.url!=='www.gstatic.com:443'){socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');return;}
      const authorized=req.headers['proxy-authorization']===expected;
      records.push({index,kind:'connect',authorized});
      if(!authorized){socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="startup-fixture"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
      connections.add(socket);socket.on('close',()=>connections.delete(socket));socket.on('error',()=>{});
      const upstream=connect(origin.address().port,'127.0.0.1',()=>{
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);
      });
      connections.add(upstream);upstream.on('close',()=>connections.delete(upstream));
      upstream.on('error',()=>socket.destroy());socket.on('close',()=>upstream.destroy());upstream.on('close',()=>socket.destroy());
    });
    await new Promise(r=>proxy.listen(0,'127.0.0.1',r));return proxy;
  };
  const proxies=[await makeProxy(0),await makeProxy(1)],ports=proxies.map(p=>p.address().port);
  let context,worker,popup,id;
  const launch=()=>chromium.launchPersistentContext(resolve(fixture,'profile'),{
    channel:'chrome',headless:true,ignoreDefaultArgs:['--disable-extensions'],
    args:['--enable-unsafe-extension-debugging','--ignore-certificate-errors','--disable-background-networking'],
  });
  const until=async(check,timeout=12000)=>{
    const end=Date.now()+timeout;
    while(!await check()){assert.ok(Date.now()<end,'Startup auth check timed out');await new Promise(r=>setTimeout(r,25));}
  };
  const action=(action,extra={})=>popup.evaluate(message=>chrome.runtime.sendMessage(message),{action,...extra});
  const warm=()=>worker.evaluate(async()=>{const {proxyHealth}=await chrome.storage.session.get('proxyHealth');return !!proxyHealth?.lastSuccess&&!proxyHealth.pending;});
  const otherRequest=async()=>{
    const cdp=await context.browser().newBrowserCDPSession();
    const {id:other}=await cdp.send('Extensions.loadUnpacked',{path:otherPath});
    const before=records.length;
    const page=await context.newPage();await page.goto(`chrome-extension://${other}/page.html`);
    await page.waitForFunction(()=>document.body.textContent==='AUTHENTICATED',{},{timeout:5000});
    const ownRecords=records.slice(before).filter(r=>r.kind==='http');
    assert.ok(ownRecords.some(r=>r.authorized));assert.equal(ownRecords.filter(r=>!r.authorized).length,0,'Other extension must reuse automatically cached credentials');
    await page.close();return {authenticated:true,challenges:0};
  };
  try{
    context=await launch();
    const cdp=await context.browser().newBrowserCDPSession();
    ({id}=await cdp.send('Extensions.loadUnpacked',{path:resolve(root,'dist/extension')}));
    popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
    worker=context.serviceWorkers().find(w=>w.url().startsWith(`chrome-extension://${id}/`))||await context.waitForEvent('serviceworker');
    await worker.evaluate(ports=>{
      const original=fetch;
      globalThis.fetch=(url,init)=>String(url)==='https://subscription.example.invalid/fixture'
        ?Promise.resolve(new Response(JSON.stringify({proxies:ports.map((port,index)=>({name:`Fixture ${index}`,type:'http',tls:true,server:'127.0.0.1',port,username:`fixture${index}`,password:`synthetic-only-${index}`}))})))
        :original(url,init);
    },ports);
    assert.equal((await action('refresh',{url:'https://subscription.example.invalid/fixture'})).ok,true);
    await action('select',{id:`127.0.0.1:${ports[0]}`});await action('connect');
    await until(warm);
    assert.ok(records.some(r=>r.kind==='connect'&&!r.authorized),'Automatic warmup must answer a fresh 407');
    assert.ok(records.some(r=>r.kind==='connect'&&r.authorized));
    assert.equal((await action('status')).data.latency,null,'Automatic auth must not invent manual latency');
    const connectedOther=await otherRequest();

    // Reset Chrome's credential cache by exiting the entire isolated process.
    // Reload the extension without opening its UI or any ordinary web page.
    await context.close();context=undefined;worker=undefined;popup=undefined;
    const beforeRestart=probes;
    context=await launch();
    const restartCDP=await context.browser().newBrowserCDPSession();
    const restartedWorker=context.waitForEvent('serviceworker');
    await restartCDP.send('Extensions.loadUnpacked',{path:resolve(root,'dist/extension')});
    worker=context.serviceWorkers().find(w=>w.url().startsWith(`chrome-extension://${id}/`))||await restartedWorker;
    // Consume the event promise even when the target was already available.
    await restartedWorker;
    await until(async()=>probes>beforeRestart&&await warm());
    const restartedOther=await otherRequest();
    assert.equal(await worker.evaluate(()=>chrome.action.getBadgeText({})),'ON');

    popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
    hold=true;const beforeHold=probes;
    await action('select',{id:`127.0.0.1:${ports[1]}`});
    await until(()=>probes>beforeHold);
    const disconnected=await action('disconnect');
    assert.equal(disconnected.data.enabled,false);
    hold=false;for(const res of held){if(!res.destroyed){res.writeHead(204);res.end();}}
    assert.equal((await action('status')).data.proxyError,'');
    assert.equal(await worker.evaluate(()=>chrome.action.getBadgeText({})),'');
    assert.equal(await worker.evaluate(()=>chrome.alarms.get('proxy-recheck')),undefined);
    await action('connect');await until(warm);
    assert.ok(records.some(r=>r.index===1&&r.kind==='connect'&&r.authorized),'Switching must authenticate the second independent endpoint');

    const report={passed:true,version:'0.3.7',chromeVersion:context.browser().version(),localSyntheticFixturesOnly:true,connectAutomaticallyAuthenticates:true,otherExtensionAfterConnect:connectedOther,fullChromeRestart:true,restorationWarmsWithoutUIOrOrdinaryPage:true,otherExtensionAfterRestart:restartedOther,manualLatencyUnchanged:true,selectionAuthenticatesIndependentEndpoint:true,disconnectCancelsWarmup:true,nativeLoginDialogCaptured:false};
    await writeFile(resolve(root,'work/auth-startup-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
    await action('disconnect');
  }finally{
    if(worker)await worker.evaluate(async()=>{await chrome.proxy.settings.clear({scope:'regular'});await chrome.storage.local.clear();await chrome.storage.session.clear();}).catch(()=>{});
    if(context)await context.close();
    for(const socket of connections)socket.destroy();origin.closeAllConnections();proxies.forEach(p=>p.closeAllConnections());
    await Promise.all([origin,...proxies].map(server=>new Promise(r=>server.close(r))));
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
