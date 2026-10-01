"""Convert public rule data only; never load scripts or Shadowrocket settings."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import ipaddress
import json
import os
from pathlib import Path
import re
import urllib.request

SOURCE = 'https://raw.githubusercontent.com/Johnshall/Shadowrocket-ADBlock-Rules-Forever/release/sr_cnip.conf'
IP_SOURCES = {
    'ipv4': 'https://raw.githubusercontent.com/gaoyifan/china-operator-ip/ip-lists/china.txt',
    'ipv6': 'https://raw.githubusercontent.com/gaoyifan/china-operator-ip/ip-lists/china6.txt',
}
ATTRIBUTION = {'authors': 'Moshel and Johnshall', 'project': 'https://github.com/Johnshall/Shadowrocket-ADBlock-Rules-Forever', 'license': 'CC-BY-SA-4.0', 'licenseUrl': 'https://creativecommons.org/licenses/by-sa/4.0/', 'changes': 'Rule section converted to ordered JSON; CIDRs normalized; other sections excluded.'}

def parse_rules(source):
    section, rows = '', []
    for raw in source.splitlines():
        line = raw.split('#', 1)[0].strip()
        if not line: continue
        if line.startswith('[') and line.endswith(']'):
            section = line[1:-1].lower(); continue
        if section != 'rule': continue
        if rows and rows[-1][0] == 'FINAL': raise ValueError('Rules after FINAL')
        fields = [x.strip() for x in line.split(',')]
        kind = fields[0].upper()
        if kind == 'FINAL':
            if len(fields) != 2 or fields[1].upper() != 'PROXY': raise ValueError('FINAL must be PROXY')
            rows.append(['FINAL', '', 1]); continue
        if len(fields) not in (3, 4) or fields[2].upper() not in ('DIRECT', 'PROXY'):
            raise ValueError('Unsupported rule format or action')
        action = int(fields[2].upper() == 'PROXY')
        if len(fields) == 4 and (kind not in ('IP-CIDR', 'IP-CIDR6') or fields[3].lower() != 'no-resolve'):
            raise ValueError('Unsupported rule option')
        value = fields[1]
        if kind in ('DOMAIN', 'DOMAIN-SUFFIX'):
            value = value.rstrip('.').encode('idna').decode('ascii').lower()
            if len(value) > 253 or not re.fullmatch(r'[a-z0-9_-]+(?:\.[a-z0-9_-]+)*', value): raise ValueError('Invalid domain')
        elif kind == 'DOMAIN-KEYWORD':
            value = value.lower()
            if not re.fullmatch(r'[a-z0-9._-]{1,253}', value): raise ValueError('Invalid keyword')
        elif kind in ('IP-CIDR', 'IP-CIDR6'):
            net = ipaddress.ip_network(value, strict=False)
            kind = 'IP-CIDR' if net.version == 4 else 'IP-CIDR6'
            value = [int(net.network_address), int(net.broadcast_address)] if net.version == 4 else [net.prefixlen] + [int(x, 16) for x in net.network_address.exploded.split(':')]
            rows.append([kind, value, action, len(fields) == 4]); continue
        elif kind == 'GEOIP':
            if value.upper() != 'CN' or action != 0: raise ValueError('Only GEOIP,CN,DIRECT supported')
            value = 'CN'
        else: raise ValueError('Unsupported rule type')
        rows.append([kind, value, action])
    if not rows or rows[-1] != ['FINAL', '', 1] or ['GEOIP', 'CN', 0] not in rows:
        raise ValueError('Missing mandatory GEOIP/FINAL')
    if len(rows) > 10000: raise ValueError('Too many rules')
    return rows

def parse_networks(text, version):
    nets = []
    for line in text.splitlines():
        line = line.split('#', 1)[0].strip()
        if not line: continue
        net = ipaddress.ip_network(line)
        if net.version != version or net.prefixlen == 0: raise ValueError('Invalid GeoIP network')
        nets.append(net)
    nets = list(ipaddress.collapse_addresses(nets))
    if version == 4: return [[int(n.network_address), int(n.broadcast_address)] for n in nets]
    return [[n.prefixlen] + [int(x, 16) for x in n.network_address.exploded.split(':')] for n in nets]

def convert(source, ipv4, ipv6):
    rows = parse_rules(source)
    four, six = parse_networks(ipv4, 4), parse_networks(ipv6, 6)
    if len(rows) < 100 or not 1000 <= len(four) <= 30000 or not 100 <= len(six) <= 30000:
        raise ValueError('Unexpectedly small or large upstream data')
    build = re.search(r'^#\s*build time:\s*(.+)$', source, re.M)
    return {'schema': 2, 'rules': rows, 'ipv4': four, 'ipv6': six, 'metadata': {
        'fetchedAt': datetime.now(timezone.utc).isoformat(), 'sourceBuild': build.group(1).strip() if build else '',
        'source': SOURCE, 'attribution': ATTRIBUTION, 'ipSources': IP_SOURCES, 'ipLicense': 'MIT',
        'ruleCount': len(rows), 'ipv4Count': len(four), 'ipv6Count': len(six)}}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args): return None

def download(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'Qingkong-Rules/1.0', 'Accept-Encoding': 'identity'})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
        data = response.read(4 * 1024 * 1024 + 1)
    if len(data) > 4 * 1024 * 1024: raise ValueError('Source exceeds limit')
    return data.decode('utf-8-sig')

def write_bundle(destination, data):
    encoded = json.dumps(data, ensure_ascii=True, separators=(',', ':')).encode()
    # Keep a wide margin below Chrome's PAC ceiling, including custom rules and code.
    if len(encoded) > 800000: raise ValueError('Compiled data exceeds size budget')
    destination.parent.mkdir(parents=True, exist_ok=True)
    tmp = destination.with_suffix('.new')
    try:
        with open(tmp, 'wb') as out:
            out.write(encoded); out.flush(); os.fsync(out.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, destination)
    finally:
        if tmp.exists(): tmp.unlink()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    try:
        result = convert(download(SOURCE), download(IP_SOURCES['ipv4']), download(IP_SOURCES['ipv6']))
        write_bundle(args.out, result)
        print(f'Routing updated: {len(result["rules"])} ordered rules, {len(result["ipv4"])} IPv4 and {len(result["ipv6"])} IPv6 networks.')
    except Exception as exc:
        print(f'Routing update failed ({type(exc).__name__}); previous bundle retained.')
        raise SystemExit(1) from None

if __name__ == '__main__': main()
