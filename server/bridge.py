"""Identity-isolated HTTPS -> original VLESS bridge. No direct outbound exists."""
from __future__ import annotations

import copy
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
import urllib.error
import urllib.request

import yaml

MAX_BYTES = 8 * 1024 * 1024


class ConfigurationError(Exception):
    """Errors are intentionally generic: never include subscription or node values."""


def atomic_json(path: Path, value, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.new')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as output:
            json.dump(value, output, ensure_ascii=False, separators=(',', ':'))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temp, path)
        os.chmod(path, mode)
    finally:
        if temp.exists():
            temp.unlink()


def load_config(path: Path):
    config = json.loads(path.read_text(encoding='utf-8'))
    required = ('domain', 'clash_path_prefix', 'panel_db', 'state_dir', 'xray_binary', 'certificate_source', 'private_key_source', 'bridge_user')
    if any(not config.get(k) or 'REPLACE' in str(config[k]) for k in required):
        raise ConfigurationError('Complete all deployment configuration fields first')
    if not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', config['domain']):
        raise ConfigurationError('Invalid public domain')
    prefix = config['clash_path_prefix']
    if not re.fullmatch(r'/(?:[A-Za-z0-9_-]+/)+', prefix):
        raise ConfigurationError('Invalid CLASH path prefix')
    config.setdefault('upstream_port', 2096)
    config.setdefault('listen_port', 2097)
    config.setdefault('port_first', 18443)
    config.setdefault('port_last', 18542)
    config.setdefault('sync_seconds', 30)
    for key in ('upstream_port', 'listen_port', 'port_first', 'port_last'):
        if type(config[key]) is not int or not 1024 <= config[key] <= 65535:
            raise ConfigurationError('Invalid service port')
    if config['port_last'] < config['port_first'] or not 5 <= config['sync_seconds'] <= 30:
        raise ConfigurationError('Invalid allocation range or synchronization period')
    for key in ('upstream_port', 'listen_port'):
        if config['port_first'] <= config[key] <= config['port_last']:
            raise ConfigurationError('Proxy ports overlap internal service ports')
    return config


def panel_clients(db_path: str, now=None):
    """One read-only SQLite snapshot. The original core still enforces quotas."""
    now = int((time.time() if now is None else now) * 1000)
    db = sqlite3.connect(Path(db_path).resolve().as_uri() + '?mode=ro', uri=True, timeout=5)
    db.row_factory = sqlite3.Row
    try:
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        inbounds = db.execute('SELECT id, enable, protocol, port, settings FROM inbounds').fetchall()
        traffic = {row['email']: dict(row) for row in db.execute('SELECT * FROM client_traffics')}
        clients = []
        for row in inbounds:
            if not row['enable'] or row['protocol'] != 'vless':
                continue
            for client in json.loads(row['settings']).get('clients', []):
                if not client.get('enable', True):
                    continue
                uuid, email, sub_id = client.get('id'), client.get('email'), client.get('subId')
                if not all(isinstance(x, str) and x for x in (uuid, email, sub_id)) or not re.fullmatch(r'[A-Za-z0-9._~-]{1,128}', sub_id):
                    continue
                expiry = client.get('expiryTime', 0) or 0
                stat = traffic.get(email)
                # Missing accounting records cannot establish the required traffic owner.
                if not stat or not stat.get('enable', 1):
                    continue
                cap = client.get('totalGB', 0) or 0
                used = (stat.get('up', 0) or 0) + (stat.get('down', 0) or 0)
                stat_cap, stat_expiry = stat.get('total', 0) or 0, stat.get('expiry_time', 0) or 0
                if (expiry > 0 and expiry <= now) or (stat_expiry > 0 and stat_expiry <= now) or (cap > 0 and used >= cap) or (stat_cap > 0 and used >= stat_cap):
                    continue
                clients.append({'inbound_id': row['id'], 'port': row['port'], 'uuid': uuid, 'email': email, 'sub_id': sub_id})
        # Ambiguous duplicate accounting identities cannot prove per-person ownership.
        identities = {}
        for client in clients:
            identities.setdefault(client['email'], set()).add((client['sub_id'], client['uuid']))
        if any(len(values) > 1 for values in identities.values()):
            raise ConfigurationError('Ambiguous panel accounting identities')
        return clients
    finally:
        db.close()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_export(config, token):
    # Only a fixed loopback upstream is allowed. Never proxy a caller-supplied URL.
    url = f"http://127.0.0.1:{config['upstream_port']}{config['clash_path_prefix']}{token}"
    request = urllib.request.Request(url, headers={'User-Agent': 'clash-verge', 'Accept': 'application/yaml', 'Accept-Encoding': 'identity', 'Host': config['domain'], 'X-Forwarded-Host': config['domain'], 'X-Forwarded-Proto': 'https'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=6) as response:
            content = response.read(MAX_BYTES + 1)
            if len(content) > MAX_BYTES:
                raise ConfigurationError('Panel export exceeds size limit')
            headers = {k: response.headers[k] for k in ('subscription-userinfo', 'profile-update-interval') if response.headers.get(k)}
        document = yaml.safe_load(content)
        if not isinstance(document, dict) or not isinstance(document.get('proxies'), list):
            raise ConfigurationError('Unsupported panel export structure')
        return document, headers
    except (urllib.error.URLError, ValueError, yaml.YAMLError) as exc:
        raise ConfigurationError('Panel export unavailable') from None


def supported_node(node):
    if not isinstance(node, dict) or node.get('type') != 'vless' or node.get('network', 'tcp') not in ('tcp', 'raw') or node.get('tls') is not True:
        return False
    reality = node.get('reality-opts')
    if not isinstance(reality, dict) or not reality.get('public-key') or not node.get('servername'):
        return False
    if node.get('flow', '') not in ('', 'xtls-rprx-vision'):
        return False
    if any(node.get(k) for k in ('ws-opts', 'grpc-opts', 'http-opts', 'h2-opts', 'dialer-proxy')):
        return False
    if node.get('encryption', 'none') != 'none':
        return False
    return isinstance(node.get('server'), str) and type(node.get('port')) is int and 0 < node['port'] < 65536


def record_key(client):
    # Same owner and inlet retain a port on UUID rotation; another owner never inherits it.
    identity = [client['inbound_id'], client['email'], client['sub_id']]
    return hashlib.sha256(json.dumps(identity, separators=(',', ':')).encode()).hexdigest()


def new_registry():
    return {'version': 1, 'records': {}}


def generate(config, previous, clients, exports):
    """Pure compiler: returns registry, bridge config and per-subscription documents."""
    registry = copy.deepcopy(previous)
    if registry.get('version') != 1:
        raise ConfigurationError('Unsupported registry version')
    records = registry['records']
    used_ports = [record['port'] for record in records.values()]
    if len(used_ports) != len(set(used_ports)):
        raise ConfigurationError('Duplicate stored proxy ports')
    if any(type(port) is not int or not config['port_first'] <= port <= config['port_last'] for port in used_ports):
        raise ConfigurationError('Existing port assignments fall outside configured range')
    used = set(used_ports)
    for record in records.values():
        record['active'] = False
    inbounds, outbounds, routes, additions = [], [{'tag': 'reject', 'protocol': 'blackhole', 'settings': {}}], [], {}
    active_keys = set()
    for client in sorted(clients, key=lambda x: (x['inbound_id'], x['email'])):
        token = client['sub_id']
        source = exports.get(token)
        if not source:
            continue
        candidates = [n for n in source[0]['proxies'] if supported_node(n) and n.get('uuid') == client['uuid'] and n.get('port') == client['port']]
        if not candidates:
            continue
        # Multiple public representations of one inlet must agree on connection settings.
        unique = {json.dumps({k: v for k, v in n.items() if k != 'name'}, sort_keys=True) for n in candidates}
        if len(unique) != 1:
            raise ConfigurationError('Ambiguous original node mapping')
        node = candidates[0]
        key = record_key(client)
        if key in active_keys:
            raise ConfigurationError('Duplicate original identity mapping')
        active_keys.add(key)
        record = records.get(key)
        if record is None:
            port = next((p for p in range(config['port_first'], config['port_last'] + 1) if p not in used), None)
            if port is None:
                raise ConfigurationError('Stable proxy port range exhausted; never reuse another identity port')
            record = records[key] = {'port': port, 'username': secrets.token_urlsafe(18), 'password': secrets.token_urlsafe(32), 'uuid': client['uuid']}
            used.add(port)
        if record['uuid'] != client['uuid']:
            record.update(uuid=client['uuid'], username=secrets.token_urlsafe(18), password=secrets.token_urlsafe(32))
        record['active'] = True
        inbound_tag, outbound_tag = f'in-{record["port"]}', f'user-{record["port"]}'
        inbounds.append({'tag': inbound_tag, 'listen': '0.0.0.0', 'port': record['port'], 'protocol': 'http', 'settings': {'accounts': [{'user': record['username'], 'pass': record['password']}], 'allowTransparent': False}, 'streamSettings': {'network': 'tcp', 'security': 'tls', 'tlsSettings': {'minVersion': '1.2', 'alpn': ['http/1.1'], 'certificates': [{'certificateFile': str(Path(config['state_dir']) / 'tls/cert.pem'), 'keyFile': str(Path(config['state_dir']) / 'tls/key.pem')}]}}})
        reality = node['reality-opts']
        outbounds.append({'tag': outbound_tag, 'protocol': 'vless', 'settings': {'vnext': [{'address': node['server'], 'port': node['port'], 'users': [{'id': client['uuid'], 'encryption': 'none', 'flow': node.get('flow', '')}]}]}, 'streamSettings': {'network': 'tcp', 'security': 'reality', 'realitySettings': {'serverName': node['servername'], 'fingerprint': node.get('client-fingerprint', 'chrome'), 'publicKey': reality['public-key'], 'shortId': reality.get('short-id', ''), 'spiderX': ''}}})
        routes.append({'type': 'field', 'inboundTag': [inbound_tag], 'outboundTag': outbound_tag})
        browser_node = {'name': f'{node.get("name", "节点")} · Chrome', 'type': 'http', 'server': config['domain'], 'port': record['port'], 'username': record['username'], 'password': record['password'], 'tls': True, 'skip-cert-verify': False}
        additions.setdefault(token, []).append(browser_node)
    routes.append({'type': 'field', 'network': 'tcp,udp', 'outboundTag': 'reject'})
    xray = {'log': {'loglevel': 'none'}, 'inbounds': inbounds, 'outbounds': outbounds, 'routing': {'domainStrategy': 'AsIs', 'rules': routes}}
    documents = {}
    for token, (source, headers) in exports.items():
        # Only subscriptions with a currently valid local panel owner enter exports.
        document = copy.deepcopy(source)
        existing_names = {n.get('name') for n in document['proxies'] if isinstance(n, dict)}
        for node in additions.get(token, []):
            while node['name'] in existing_names:
                node['name'] += ' · 浏览器'
            existing_names.add(node['name'])
            document['proxies'].append(node)
        documents[token] = (yaml.safe_dump(document, allow_unicode=True, sort_keys=False).encode(), headers)
    return registry, xray, documents
