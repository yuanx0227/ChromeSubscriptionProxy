import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
import routing_update as routing

class RoutingChecks(unittest.TestCase):
    def test_rule_order_and_excluded_sections(self):
        source='''[General]
dns-server = https://unwanted.invalid
[Rule]
DOMAIN,EXAMPLE.COM,Direct # comment
DOMAIN-SUFFIX,example.com,proxy
DOMAIN-KEYWORD,cdn,Direct
IP-CIDR,1.2.3.4/24,PROXY,no-resolve
IP-CIDR,2001:db8::1/32,DIRECT
GEOIP,CN,DIRECT
FINAL,Proxy
[URL Rewrite]
bad code goes here
[MITM]
hostname=*
'''
        rules=routing.parse_rules(source)
        self.assertEqual([r[0] for r in rules],['DOMAIN','DOMAIN-SUFFIX','DOMAIN-KEYWORD','IP-CIDR','IP-CIDR6','GEOIP','FINAL'])
        self.assertEqual(rules[0],['DOMAIN','example.com',0])
        self.assertEqual(rules[3],['IP-CIDR',[16909056,16909311],1,True])
        self.assertEqual(rules[-1],['FINAL','',1])

    def test_invalid_update_never_replaces_last_good_file(self):
        with tempfile.TemporaryDirectory() as folder:
            dest=Path(folder)/'routing.json';dest.write_text('last-valid')
            with self.assertRaises(ValueError):routing.parse_rules('[Rule]\nRULE-SET,external,PROXY\nFINAL,PROXY')
            with self.assertRaises(ValueError):routing.parse_rules('[Rule]\nGEOIP,CN,DIRECT\nFINAL,DIRECT')
            with self.assertRaises(ValueError):routing.parse_rules('[Rule]\nGEOIP,CN,DIRECT\nFINAL,PROXY\nDOMAIN,x,DIRECT')
            with patch.object(routing,'download',side_effect=OSError()), patch.object(sys,'argv',['routing_update','--out',str(dest)]):
                with self.assertRaises(SystemExit):routing.main()
            self.assertEqual(dest.read_text(),'last-valid')
            with patch.object(routing.os,'replace',side_effect=OSError()):
                with self.assertRaises(OSError):routing.write_bundle(dest,{'schema':2})
            self.assertEqual(dest.read_text(),'last-valid')
            self.assertFalse(dest.with_suffix('.new').exists())

    def test_actual_bundle_keeps_geoip_separate_and_final_proxy(self):
        data=json.loads((Path(__file__).resolve().parents[1]/'extension/src/routing-data.json').read_text())
        self.assertEqual(data['rules'][-1],['FINAL','',1])
        self.assertIn(['GEOIP','CN',0],data['rules'])
        self.assertGreater(len(data['ipv4']),1000)
        self.assertGreater(len(data['ipv6']),100)
        self.assertEqual(data['metadata']['attribution']['license'],'CC-BY-SA-4.0')

if __name__=='__main__':unittest.main()
