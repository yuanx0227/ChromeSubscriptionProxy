export const ROUTING_URL = 'https://bwh.yxzyl.cn/qingkong/routing-v1.json';
export const ROUTING_HOST = new URL(ROUTING_URL).hostname;
export const ROUTING_INTERVAL = 86400000;
export function validateRouting(data) {
  const invalid = () => { throw new Error('分流规则无效'); };
  const integer = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;
  const range = row => Array.isArray(row) && row.length === 2 && row.every(n => integer(n, 4294967295)) && row[0] <= row[1];
  const prefix = row => Array.isArray(row) && row.length === 9 && integer(row[0],128) && row[0] > 0 && row.slice(1).every(n => integer(n,65535));
  if (!data || data.schema !== 2 || !Array.isArray(data.rules) || !data.rules.length || data.rules.length > 10000 || !Array.isArray(data.ipv4) || !Array.isArray(data.ipv6) || data.ipv4.length > 30000 || data.ipv6.length > 30000 || !data.ipv4.length || !data.ipv6.length) invalid();
  let previous = -1;
  for (const row of data.ipv4) { if (!range(row) || row[0] <= previous) invalid(); previous = row[1]; }
  if (!data.ipv6.every(prefix)) invalid();
  let geo = false;
  for (let i = 0; i < data.rules.length; i++) {
    const row = data.rules[i];
    if (!Array.isArray(row) || ![0,1].includes(row[2])) invalid();
    const [type, value] = row;
    if (type === 'IP-CIDR' || type === 'IP-CIDR6') {
      if (row.length !== 4 || typeof row[3] !== 'boolean' || !(type === 'IP-CIDR' ? range(value) : prefix(value))) invalid();
    } else {
      if (row.length !== 3 || typeof value !== 'string') invalid();
      if (type === 'DOMAIN' || type === 'DOMAIN-SUFFIX') { if (value.length > 253 || !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(value)) invalid(); }
      else if (type === 'DOMAIN-KEYWORD') { if (!/^[a-z0-9._-]{1,253}$/.test(value)) invalid(); }
      else if (type === 'GEOIP') { if (value !== 'CN' || row[2] !== 0) invalid(); geo = true; }
      else if (type === 'FINAL') { if (i !== data.rules.length-1 || value !== '' || row[2] !== 1) invalid(); }
      else invalid();
    }
  }
  if (!geo || data.rules.at(-1)[0] !== 'FINAL' || !data.metadata || !Number.isFinite(Date.parse(data.metadata.fetchedAt))) invalid();
  if (JSON.stringify(data).length > 800000) invalid();
  return data;
}

export async function fetchRouting(fetcher = fetch) {
  const response = await fetcher(ROUTING_URL, {cache:'no-store', credentials:'omit', redirect:'error', referrerPolicy:'no-referrer', signal:AbortSignal.timeout(20000)});
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('分流规则下载失败');
  const reader = response.body.getReader(), chunks=[];
  let bytes=0;
  try {
    for (;;) { const {done,value}=await reader.read(); if (done) break; bytes+=value.length; if(bytes>800000)throw new Error('分流规则过大'); chunks.push(value); }
  } finally { await reader.cancel().catch(()=>{}); }
  const buffer = new Uint8Array(bytes); let offset=0;
  for(const chunk of chunks) {buffer.set(chunk,offset);offset+=chunk.length;}
  return validateRouting(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer)));
}
