import {parseDocument} from 'yaml';
import {ROUTING_HOST} from './routing.js';

export const PROBE_URL = 'https://www.gstatic.com/generate_204';
export const PROBE_HOST = new URL(PROBE_URL).hostname;
export const MAX_SUB_BYTES = 8 * 1024 * 1024;

export function subscriptionURL(value) {
  let u;
  try { u = new URL(value); } catch { throw new Error('订阅地址格式不正确'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.hash)
    throw new Error('订阅地址必须为 HTTPS，且不能带用户名、密码或片段');
  if (u.hostname === PROBE_HOST) throw new Error('该域名保留用于连通检测');
  return u.href;
}

function endpointHost(value) {
  if (typeof value !== 'string' || !value || /[\s\/\\;@?#]/u.test(value)) return null;
  try {
    const host = value.includes(':') && !value.startsWith('[') ? `[${value}]` : value;
    const u = new URL(`https://${host}/`);
    return u.port || u.username || u.password ? null : u.hostname.toLowerCase();
  } catch { return null; }
}

export function parseSubscription(text) {
  let doc, data;
  try {
    doc = parseDocument(text, {uniqueKeys: true, customTags: [], schema: 'core'});
    if (doc.errors.length || doc.warnings.length) throw new Error();
    data = doc.toJS({maxAliasCount: 50});
  } catch { throw new Error('订阅不是受支持的 CLASH YAML'); }
  if (!data || !Array.isArray(data.proxies) || data.proxies.length > 2000)
    throw new Error('订阅需要顶层 proxies 列表（最多 2000 项）');
  const nodes = [], unsupported = [], seen = new Set();
  for (const p of data.proxies) {
    const name = typeof p?.name === 'string' ? p.name.slice(0, 120) : '未命名节点';
    let reason = '';
    const host = endpointHost(p?.server), port = p?.port;
    if (p?.type !== 'http' || p.tls !== true) reason = '该节点不能直接用于浏览器代理';
    else if (!host || !Number.isInteger(port) || port < 1 || port > 65535) reason = '代理地址或端口无效';
    else if (p['skip-cert-verify'] === true || (p.sni && p.sni.toLowerCase() !== host)) reason = '不支持跳过证书验证或不同的 SNI';
    else if (typeof p.username !== 'string' || !p.username || typeof p.password !== 'string' || !p.password || /[\r\n:]/.test(p.username) || /[\r\n]/.test(p.password)) reason = '需要有效的独立代理账号';
    else if (p.headers || p['dialer-proxy'] || p['client-fingerprint'] || p['certificate'] || p['private-key']) reason = '节点包含 Chrome 无法应用的连接选项';
    const id = host && `${host}:${port}`;
    if (!reason && seen.has(id)) throw new Error('存在重复代理端点，无法保证账号隔离');
    if (reason) unsupported.push({name, reason});
    else { seen.add(id); nodes.push({id, name, host, port, username: p.username, password: p.password}); }
  }
  return {nodes, unsupported};
}

export function normalizeRules(proxyText, directText, reservedHost) {
  function domains(text) {
    const lines = text.split(/[\n,]/).map(x => x.trim()).filter(Boolean);
    if (lines.length > 2000) throw new Error('每类规则最多 2000 个域名');
    return [...new Set(lines.map(s => {
      s = s.replace(/^\*\./, '').replace(/\.$/, '');
      if (/[\s\/:@?#\\]/u.test(s)) throw new Error('规则只填写域名，不带协议、路径或端口');
      let h;
      try { h = new URL(`https://${s}`).hostname.toLowerCase(); } catch { throw new Error('域名规则格式不正确'); }
      if (!h.includes('.') || !/^[a-z0-9.-]+$/.test(h) || h.split('.').some(x => !x || x.startsWith('-') || x.endsWith('-')))
        throw new Error('域名规则格式不正确');
      if (h === reservedHost || h === PROBE_HOST || h === ROUTING_HOST) throw new Error('订阅、规则更新和检测域名为保留规则');
      return h;
    }))];
  }
  const proxy = domains(proxyText), direct = domains(directText);
  if (proxy.some(x => direct.includes(x))) throw new Error('同一域名不能同时设置为代理和直连');
  return {proxy, direct};
}

export async function readLimited(response) {
  if (!response.ok) throw new Error('订阅更新失败，请检查地址及网络');
  if (Number(response.headers.get('content-length')) > MAX_SUB_BYTES) throw new Error('订阅超过 8 MB 限制');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_SUB_BYTES) throw new Error('订阅超过 8 MB 限制');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
}
