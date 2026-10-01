"""Developer refresh using the same converter deployed by the daily server timer."""
from pathlib import Path
import subprocess
import sys
root = Path(__file__).resolve().parents[1]
raise SystemExit(subprocess.call([sys.executable, str(root / 'server/routing_update.py'), '--out', str(root / 'extension/src/routing-data.json')]))
