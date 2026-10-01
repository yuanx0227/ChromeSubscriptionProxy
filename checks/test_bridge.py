"""Indispensable local checks for isolation and original accounting route compilation."""
import copy
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from bridge import ConfigurationError, generate, new_registry, panel_clients
import yaml


CONFIG = {'domain': 'bridge.example.com', 'port_first': 18443, 'port_last': 18448, 'state_dir': '/var/lib/example'}


def fixtures():
    clients, exports = [], {}
    for i in range(2):
        client = {'inbound_id': 1, 'port': 10443, 'uuid': f'00000000-0000-4000-8000-00000000000{i}', 'email': f'user{i}', 'sub_id': f'subtoken{i}'}
        node = {'name': f'node{i}', 'type': 'vless', 'server': 'original.example.com', 'port': 10443, 'uuid': client['uuid'], 'tls': True, 'network': 'tcp', 'servername': 'www.example.com', 'flow': 'xtls-rprx-vision', 'reality-opts': {'public-key': 'test-only', 'short-id': '1234'}}
        clients.append(client)
        exports[client['sub_id']] = ({'proxies': [node], 'proxy-groups': [{'name': 'Proxy', 'type': 'select', 'proxies': [node['name']]}]}, {})
    return clients, exports


class BridgeChecks(unittest.TestCase):
    def test_isolated_credentials_and_original_routes(self):
        clients, exports = fixtures()
        registry, xray, docs = generate(CONFIG, new_registry(), clients, exports)
        self.assertEqual(len(xray['inbounds']), 2)
        self.assertEqual(xray['outbounds'][0]['protocol'], 'blackhole')
        self.assertNotIn('freedom', {o['protocol'] for o in xray['outbounds']})
        credentials = []
        for index, client in enumerate(clients):
            doc = yaml.safe_load(docs[client['sub_id']][0])
            self.assertEqual(doc['proxies'][0], exports[client['sub_id']][0]['proxies'][0])
            self.assertEqual(len(doc['proxies']), 2)
            browser = doc['proxies'][1]
            inbound = next(i for i in xray['inbounds'] if i['port'] == browser['port'])
            self.assertEqual(inbound['settings']['accounts'], [{'user': browser['username'], 'pass': browser['password']}])
            route = next(r for r in xray['routing']['rules'] if r.get('inboundTag') == [inbound['tag']])
            outbound = next(o for o in xray['outbounds'] if o['tag'] == route['outboundTag'])
            self.assertEqual(outbound['settings']['vnext'][0]['users'][0]['id'], client['uuid'])
            credentials.append(browser['password'])
        self.assertNotEqual(*credentials)
        self.assertNotEqual(xray['inbounds'][0]['port'], xray['inbounds'][1]['port'])
        self.assertEqual(generate(CONFIG, registry, clients, exports)[1], xray)

    def test_deleted_identity_port_is_never_reassigned_and_uuid_rotates_credentials(self):
        clients, exports = fixtures()
        registry, before, _ = generate(CONFIG, new_registry(), clients, exports)
        changed = copy.deepcopy(clients)
        changed[0]['uuid'] = '00000000-0000-4000-8000-000000000009'
        exports[changed[0]['sub_id']][0]['proxies'][0]['uuid'] = changed[0]['uuid']
        registry, after, _ = generate(CONFIG, registry, changed, exports)
        self.assertEqual(before['inbounds'][0]['port'], after['inbounds'][0]['port'])
        self.assertNotEqual(before['inbounds'][0]['settings']['accounts'], after['inbounds'][0]['settings']['accounts'])
        changed[0]['email'] = 'another-owner'
        registry, after, _ = generate(CONFIG, registry, changed, exports)
        self.assertEqual(len(registry['records']), 3)
        self.assertNotIn(18443, [i['port'] for i in after['inbounds']])

    def test_unmatched_and_unsupported_nodes_get_no_bridge(self):
        clients, exports = fixtures()
        exports[clients[0]['sub_id']][0]['proxies'][0]['uuid'] = clients[1]['uuid']
        exports[clients[1]['sub_id']][0]['proxies'][0]['network'] = 'ws'
        registry, config, docs = generate(CONFIG, new_registry(), clients, exports)
        self.assertEqual(config['inbounds'], [])
        self.assertTrue(all(len(yaml.safe_load(content[0])['proxies']) == 1 for content in docs.values()))

    def test_disabled_expired_quota_users_do_not_receive_entrances(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'panel.db'
            db = sqlite3.connect(path)
            db.execute('CREATE TABLE inbounds (id INTEGER, enable INTEGER, protocol TEXT, port INTEGER, settings TEXT)')
            db.execute('CREATE TABLE client_traffics (email TEXT, enable INTEGER, up INTEGER, down INTEGER, total INTEGER, expiry_time INTEGER)')
            base = {'id': 'test-uuid', 'subId': 'short', 'enable': True, 'expiryTime': 0, 'totalGB': 0}
            clients = [{**base, 'email': str(i)} for i in range(5)]
            clients[1]['enable'] = False
            clients[2]['expiryTime'] = 1000
            clients[3]['totalGB'] = 10
            db.execute('INSERT INTO inbounds VALUES (1,1,\'vless\',10443,?)', (json.dumps({'clients': clients}),))
            db.executemany('INSERT INTO client_traffics VALUES (?,?,?,?,?,?)', [(str(i), int(i != 4), 5, 5, 0, 0) for i in range(5)])
            db.commit(); db.close()
            result = panel_clients(str(path), now=2)
            self.assertEqual([x['email'] for x in result], ['0'])


if __name__ == '__main__':
    unittest.main()
