"""Retrieve upstream notices for the public rule snapshot, without executing content."""
from pathlib import Path
import urllib.request

dest = Path(__file__).resolve().parents[1] / 'docs/licenses'
dest.mkdir(exist_ok=True)
for name, url in {
    'dnsmasq-china-list.txt': 'https://cdn.jsdelivr.net/gh/felixonmars/dnsmasq-china-list@master/LICENSE',
    'china-operator-ip.txt': 'https://cdn.jsdelivr.net/gh/gaoyifan/china-operator-ip@master/LICENSE',
}.items():
    try:
        with urllib.request.urlopen(url, timeout=15) as response:
            content = response.read(100000).decode()
        (dest / name).write_text(content, encoding='utf-8')
        print(name + ': ' + content[:160].replace('\n', ' ').encode('ascii', errors='replace').decode())
    except OSError:
        print(name + ': upstream notice download unavailable')
