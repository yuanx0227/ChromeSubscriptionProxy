import {PROBE_HOST} from './model.js';
import {ROUTING_HOST, validateRouting} from './routing.js';

// Kept ES5-compatible because Chrome runs PAC in a separate JavaScript engine.
function findProxy(url, host) {
  host = host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  function suffix(h, d) { return h === d || h.slice(-d.length - 1) === '.' + d; }
  function ipv4(s) {
    var a = s.split('.'); if (a.length !== 4) return -1;
    var n = 0;
    for (var i = 0; i < 4; i++) { if (!/^\d+$/.test(a[i]) || +a[i] > 255) return -1; n = n * 256 + +a[i]; }
    return n;
  }
  function ipv6(s) {
    s = s.replace(/%.*/, '');
    if (s.indexOf(':') < 0) return null;
    if (s.indexOf('.') >= 0) {
      var pos = s.lastIndexOf(':'), n = ipv4(s.slice(pos + 1));
      if (n < 0) return null;
      s = s.slice(0, pos + 1) + Math.floor(n / 65536).toString(16) + ':' + (n % 65536).toString(16);
    }
    var half = s.split('::'); if (half.length > 2) return null;
    var left = half[0] ? half[0].split(':') : [], right = half[1] ? half[1].split(':') : [];
    if ((half.length === 1 && left.length !== 8) || (half.length === 2 && left.length + right.length >= 8)) return null;
    var out = left.slice();
    if (half.length === 2) while (out.length < 8 - right.length) out.push('0');
    out = out.concat(right);
    for (var i = 0; i < 8; i++) { if (!/^[0-9a-f]{1,4}$/.test(out[i])) return null; out[i] = parseInt(out[i], 16); }
    return out;
  }
  function local4(n) {
    return n >= 0 && (Math.floor(n / 16777216) === 10 || Math.floor(n / 16777216) === 127 ||
      Math.floor(n / 1048576) === 2753 || Math.floor(n / 65536) === 49320 || Math.floor(n / 65536) === 43518);
  }
  function local(s) {
    var n = ipv4(s); if (n >= 0) return local4(n);
    var v = ipv6(s); if (!v) return false;
    if ((v[0] & 0xfe00) === 0xfc00 || (v[0] & 0xffc0) === 0xfe80) return true;
    if (v.slice(0, 7).join(',') === '0,0,0,0,0,0,0' && v[7] <= 1) return true;
    return v.slice(0, 5).join(',') === '0,0,0,0,0' && v[5] === 65535 && local4(v[6] * 65536 + v[7]);
  }
  function domestic(s) {
    var n = ipv4(s), lo = 0, hi = cn4.length - 1;
    if (n >= 0) {
      while (lo <= hi) { var m = (lo + hi) >> 1; if (n < cn4[m][0]) hi = m - 1; else if (n > cn4[m][1]) lo = m + 1; else return true; }
      return false;
    }
    var v = ipv6(s); if (!v) return false;
    if (v.slice(0, 5).join(',') === '0,0,0,0,0' && v[5] === 65535) return domestic(Math.floor(v[6] / 256) + '.' + v[6] % 256 + '.' + Math.floor(v[7] / 256) + '.' + v[7] % 256);
    for (var i = 0; i < cn6.length; i++) {
      var bits = cn6[i][0], ok = true;
      for (var k = 0; bits > 0; k++, bits -= 16) {
        var shift = bits >= 16 ? 0 : 16 - bits;
        if ((v[k] >>> shift) !== (cn6[i][k + 1] >>> shift)) { ok = false; break; }
      }
      if (ok) return true;
    }
    return false;
  }
  if (host === 'localhost' || suffix(host, 'localhost') || suffix(host, 'local') || (host.indexOf('.') < 0 && host.indexOf(':') < 0) || local(host)) return 'DIRECT';
  if (host === subscriptionHost || host === routingHost) return 'DIRECT';
  if (host === probeHost) return proxy;
  var literal = ipv4(host) >= 0 || ipv6(host), resolved = literal ? host : '';
  if (!literal) { try { resolved = typeof dnsResolveEx === 'function' ? dnsResolveEx(host) : dnsResolve(host); } catch (e) {} }
  var ips = (resolved || '').toLowerCase().split(';').map(function(x){return x.trim();}).filter(function(x) { return !!x; });
  if (ips.length && ips.every(local)) return 'DIRECT';
  for (var r = 0; r < rules.length; r++) if (suffix(host, rules[r][0])) return rules[r][1] ? proxy : 'DIRECT';
  function cidr6(s, network) {
    var address = ipv6(s); if (!address) return false;
    for (var bits=network[0], k=0; bits>0; bits-=16, k++) {
      var shift = bits>=16 ? 0 : 16-bits;
      if ((address[k]>>>shift)!==(network[k+1]>>>shift)) return false;
    }
    return true;
  }
  function route(address) {
    for (var i=0; i<sourceRules.length; i++) {
      var entry=sourceRules[i], kind=entry[0], value=entry[1], match=false;
      if (kind==='DOMAIN') match=host===value;
      else if (kind==='DOMAIN-SUFFIX') match=suffix(host,value);
      else if (kind==='DOMAIN-KEYWORD') match=host.indexOf(value)>=0;
      else if (kind==='IP-CIDR' && (!entry[3] || literal)) {
        var n=ipv4(address);
        match=n>=0 && n>=value[0] && n<=value[1];
      } else if (kind==='IP-CIDR6' && (!entry[3] || literal)) match=cidr6(address,value);
      else if (kind==='GEOIP') match=domestic(address);
      else if (kind==='FINAL') match=true;
      if(match) return entry[2] ? proxy : 'DIRECT';
    }
    return proxy;
  }
  // Chrome PAC does not expose which DNS answer it will use. Ambiguous results stay proxied.
  return ips.length ? (ips.every(function(ip){return route(ip)==='DIRECT';}) ? 'DIRECT' : proxy) : route('');
}

export function buildPAC(state, data) {
  validateRouting(data);
  const node = state.nodes.find(n => n.id === state.selectedId);
  const rules = [...state.rules.proxy.map(x => [x, true]), ...state.rules.direct.map(x => [x, false])].sort((a, b) => b[0].length - a[0].length);
  // A removed selection deliberately stays blocked; never append DIRECT.
  const proxy = node ? `HTTPS ${node.host}:${node.port}` : 'PROXY 127.0.0.1:1';
  const script = `var proxy=${JSON.stringify(proxy)}, subscriptionHost=${JSON.stringify(state.subscriptionUrl ? new URL(state.subscriptionUrl).hostname : '')}, routingHost=${JSON.stringify(ROUTING_HOST)}, probeHost=${JSON.stringify(PROBE_HOST)}, rules=${JSON.stringify(rules)}, sourceRules=${JSON.stringify(data.rules)}, cn4=${JSON.stringify(data.ipv4)}, cn6=${JSON.stringify(data.ipv6)};\nvar FindProxyForURL=${findProxy.toString()};`;
  if (new TextEncoder().encode(script).length > 1024 * 1024) throw new Error('分流配置过大，请减少自定义域名规则');
  return script;
}
