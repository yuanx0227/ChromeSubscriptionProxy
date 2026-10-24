import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parseSubscription, normalizeRules, subscriptionURL} from '../extension/src/model.js';
import {buildPAC} from '../extension/src/pac.js';
import {validateRouting, fetchRouting, ROUTING_HOST} from '../extension/src/routing.js';

const node = {name: 'Alice', type: 'http', server: 'bridge.example.com', port: 18443, tls: true, username: 'alice', password: 'test-only'};
const state = {nodes: parseSubscription(JSON.stringify({proxies: [node]})).nodes, subscriptionUrl: 'https://subscription.example.com/test', selectedId: 'bridge.example.com:18443', rules: normalizeRules('example.com', 'local.example.com', '')};
const dataset = {schema:2,rules:[['DOMAIN-SUFFIX','baidu.com',0],['GEOIP','CN',0],['FINAL','',1]], metadata:{fetchedAt:'2026-09-27T00:00:00Z'}, ipv4: [[0x01000100, 0x010001ff]], ipv6: [[32, 0x240e, 0, 0, 0, 0, 0, 0, 0]]};
function pac(s = state, records = {}, data=dataset) {
  const context = {dnsResolveEx: host => records[host] || ''};
  vm.createContext(context); vm.runInContext(buildPAC(s, data), context);
  return host => context.FindProxyForURL(`https://${host}/`, host);
}

test('imports only authenticated, certificate-verified HTTPS endpoints', () => {
  const result = parseSubscription(JSON.stringify({proxies: [node, {...node, type: 'vless'}, {...node, tls: false}, {...node, 'skip-cert-verify': true}]}));
  assert.equal(result.nodes.length, 1); assert.equal(result.unsupported.length, 3);
  assert.throws(() => parseSubscription(JSON.stringify({proxies: [node, {...node, username: 'bob'}]})));
  assert.throws(() => subscriptionURL('http://example.com/sub'));
  assert.throws(() => parseSubscription('proxies: []\nproxies: []'));
});

test('ordered source rules, exact names, keywords, IPv4/IPv6 and no-resolve are preserved',()=>{
  const data={...dataset,rules:[['DOMAIN','exact.test',0],['IP-CIDR',[0x08080800,0x080808ff],1,false],['DOMAIN-SUFFIX','test',0],['DOMAIN-KEYWORD','proxyword',1],['IP-CIDR6',[48,0x2001,0xdb8,1,0,0,0,0,0],0,false],['IP-CIDR',[0x01000100,0x010001ff],1,true],['GEOIP','CN',0],['FINAL','',1]]};
  const route=pac({...state,rules:{proxy:[],direct:[]}}, {'exact.test':'8.8.8.8','later.test':'8.8.8.8','cn.example':'1.0.1.1','v6.example':'2001:db8:1::1'},data);
  assert.equal(route('exact.test'),'DIRECT');
  assert.match(route('later.test'),/^HTTPS/);
  assert.equal(route('other.test'),'DIRECT');
  assert.match(route('proxyword.example'),/^HTTPS/);
  assert.equal(route('v6.example'),'DIRECT');
  assert.match(route('1.0.1.1'),/^HTTPS/);
  assert.equal(route('cn.example'),'DIRECT');
  assert.equal(route(ROUTING_HOST),'DIRECT');
  assert.match(route('unresolved.example'),/^HTTPS/);
});

test('untrusted routing data cannot insert code, unknown directives, fallback or oversized responses',async()=>{
  for(const rules of [[['SCRIPT','alert(1)',0]], [['FINAL','',0]], [['DOMAIN','x;DIRECT',0],...dataset.rules], [['FINAL','',1],...dataset.rules]])
    assert.throws(()=>validateRouting({...dataset,rules}));
  assert.throws(()=>validateRouting({...dataset,ipv4:[[10,20],[15,30]]}));
  await assert.rejects(fetchRouting(async()=>new Response('x'.repeat(800001),{headers:{'content-type':'application/json'}})));
  await assert.rejects(fetchRouting(async()=>new Response('{}',{status:503,headers:{'content-type':'application/json'}})));
  assert.deepEqual(await fetchRouting(async()=>new Response(JSON.stringify(dataset),{headers:{'content-type':'application/json'}})),dataset);
});
test('Smart honors private networks, specific custom rules, domain and IP rules', () => {
  const route = pac(state, {'private.example.com': '192.168.1.2', 'private.test': '192.168.1.2', 'ip-cn.test': '1.0.1.1', 'ipv6-cn.test': '240e::10', 'mixed.test': '240e::10;2606:4700::1111'});
  for (const h of ['localhost', 'printer', '127.0.0.1', '10.1.2.3', '172.16.1.1', '172.31.255.255', '192.168.1.2', '[::1]', 'fc00::1', 'fe80::1', '::ffff:192.168.1.2', 'private.test', 'local.example.com', 'a.local.example.com', 'baidu.com', 'www.baidu.com', 'ip-cn.test', 'ipv6-cn.test', 'subscription.example.com']) assert.equal(route(h), 'DIRECT', h);
  for (const h of ['172.15.1.1', '172.32.1.1', 'unknown.test', 'example.com', 'a.example.com', 'notbaidu.com', 'mixed.test', 'www.gstatic.com', '2606:4700::1111', 'private.example.com']) assert.equal(route(h), 'HTTPS bridge.example.com:18443', h);
});
test('domain decisions skip local DNS, so poisoned answers cannot bypass proxy rules', () => {
  const data = {...dataset, rules: [['DOMAIN-SUFFIX','early.test',1],['IP-CIDR',[0x08080800,0x080808ff],1,false],['DOMAIN-SUFFIX','proxied.test',1],['DOMAIN-SUFFIX','direct.test',0],['GEOIP','CN',0],['FINAL','',1]]};
  const lookups = [], records = {'example.com': '127.0.0.1', 'proxied.test': '10.0.0.1', 'direct.test': '8.8.8.8', 'intranet.test': '10.0.0.2'};
  const context = {dnsResolveEx: host => { lookups.push(host); return records[host] || ''; }};
  vm.createContext(context); vm.runInContext(buildPAC(state, data), context);
  const route = host => context.FindProxyForURL(`https://${host}/`, host);
  assert.match(route('example.com'), /^HTTPS/);
  assert.match(route('early.test'), /^HTTPS/);
  assert.match(route('proxied.test'), /^HTTPS/);
  assert.deepEqual(lookups, []);
  // An earlier address rule with the other action still needs the address, in rule order.
  assert.match(route('direct.test'), /^HTTPS/);
  assert.equal(route('intranet.test'), 'DIRECT');
  assert.deepEqual(lookups, ['direct.test', 'intranet.test']);
});
test('removed selection blocks only proxy routes and never appends a DIRECT fallback', () => {
  const route = pac({...state, nodes: []});
  assert.equal(route('unknown.test'), 'PROXY 127.0.0.1:1');
  assert.equal(route('baidu.com'), 'DIRECT');
  assert.equal(route('subscription.example.com'), 'DIRECT');
});
test('normalizes IDNs and rejects rule conflicts and endpoint injection', () => {
  assert.equal(normalizeRules('例子.com', '', '').proxy[0], 'xn--fsqu00a.com');
  assert.throws(() => normalizeRules('example.com', '*.example.com', ''));
  assert.throws(() => normalizeRules('https://example.com', '', ''));
  assert.throws(() => normalizeRules('www.gstatic.com', '', ''));
  assert.equal(parseSubscription(JSON.stringify({proxies: [{...node, server: 'host; DIRECT'}]})).nodes.length, 0);
});
