"""Linux-only supervisor and loopback subscription adapter; never logs request paths."""
from __future__ import annotations

import argparse
import concurrent.futures
import copy
import json
import os
from pathlib import Path
import signal
import ssl
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from bridge import ConfigurationError, atomic_json, fetch_export, generate, load_config, new_registry, panel_clients


class Supervisor:
    def __init__(self, config):
        import pwd
        self.config = config
        self.account = pwd.getpwnam(config['bridge_user'])
        if self.account.pw_uid == 0:
            raise ConfigurationError('Bridge child must use an unprivileged account')
        self.root = Path(config['state_dir'])
        self.root.mkdir(parents=True, exist_ok=True)
        os.chown(self.root, 0, self.account.pw_gid)
        os.chmod(self.root, 0o750)
        self.registry_path = self.root / 'registry.json'
        self.registry = json.loads(self.registry_path.read_text()) if self.registry_path.exists() else new_registry()
        self.lock = threading.Lock()
        self.documents = {}
        self.process = None
        self.last_config = None
        self.last_certificate = None
        self.last_ports = None
        self.stopping = threading.Event()

    def child_args(self):
        return {'user': self.account.pw_uid, 'group': self.account.pw_gid, 'extra_groups': [], 'cwd': str(self.root), 'env': {'PATH': '/usr/bin:/bin'}, 'stdin': subprocess.DEVNULL, 'stdout': subprocess.DEVNULL, 'stderr': subprocess.DEVNULL}

    def stop_child(self):
        if self.process is not None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
            self.process = None

    def share_file(self, path):
        os.chown(path, 0, self.account.pw_gid)
        os.chmod(path, 0o640)

    def copy_certificate(self):
        cert = Path(self.config['certificate_source']).read_bytes()
        key = Path(self.config['private_key_source']).read_bytes()
        pair = (cert, key)
        if pair == self.last_certificate:
            return False
        tls = self.root / 'tls'
        tls.mkdir(exist_ok=True)
        os.chown(tls, 0, self.account.pw_gid)
        os.chmod(tls, 0o750)
        for name, content in (('cert.pem', cert), ('key.pem', key)):
            tmp = tls / (name + '.new')
            fd = os.open(tmp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
            with os.fdopen(fd, 'wb') as file:
                file.write(content)
        # Check that renewal has not exposed a mismatched certificate/key pair.
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(tls / 'cert.pem.new', tls / 'key.pem.new')
        for name in ('cert.pem', 'key.pem'):
            os.replace(tls / (name + '.new'), tls / name)
            self.share_file(tls / name)
        self.last_certificate = pair
        return True

    def firewall(self, ports):
        if ports == self.last_ports:
            return
        # Only this dedicated table is changed; existing host firewall rules remain authoritative.
        table = 'csp_bridge'
        found = subprocess.run(['/usr/sbin/nft', 'list', 'table', 'inet', table], capture_output=True, timeout=5)
        if found.returncode not in (0, 1):
            raise ConfigurationError('Cannot inspect bridge firewall table')
        if found.returncode == 0 and b'chrome-subscription-proxy-owned' not in found.stdout:
            raise ConfigurationError('Firewall table name is already owned by another service')
        rules = [f'delete table inet {table}'] if found.returncode == 0 else []
        rules += [f'table inet {table} {{', 'comment "chrome-subscription-proxy-owned"', 'chain input {', 'type filter hook input priority -10; policy accept;']
        if ports:
            rules.append('tcp dport { ' + ', '.join(str(p) for p in sorted(ports)) + ' } accept')
        rules += [f'tcp dport {self.config["port_first"]}-{self.config["port_last"]} drop', '}', '}']
        result = subprocess.run(['/usr/sbin/nft', '-f', '-'], input='\n'.join(rules) + '\n', text=True, capture_output=True, timeout=5)
        if result.returncode:
            raise ConfigurationError('Bridge firewall update failed')
        self.last_ports = set(ports)

    def fail_closed(self):
        with self.lock:
            self.documents = {}
        self.stop_child()
        self.last_config = None
        try:
            self.firewall(set())
        except Exception:
            print('Bridge firewall unavailable; child stopped.', flush=True)

    def synchronize(self):
        clients = panel_clients(self.config['panel_db'])
        tokens = sorted({c['sub_id'] for c in clients})
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda token: fetch_export(self.config, token), tokens))
        exports = dict(zip(tokens, results))
        registry, xray, documents = generate(self.config, self.registry, clients, exports)
        cert_changed = self.copy_certificate()
        changed = self.last_config != xray or cert_changed or (xray['inbounds'] and (not self.process or self.process.poll() is not None))
        if changed:
            candidate = self.root / 'bridge.next.json'
            atomic_json(candidate, xray)
            self.share_file(candidate)
            validation = subprocess.run([self.config['xray_binary'], 'run', '-test', '-config', str(candidate)], timeout=15, **self.child_args())
            if validation.returncode:
                raise ConfigurationError('Generated bridge config rejected by Xray')
            # Persist allocated ports BEFORE exposing any listeners or credentials.
            atomic_json(self.registry_path, registry)
            self.registry = registry
            with self.lock:
                self.documents = {}
            self.stop_child()
            self.firewall({i['port'] for i in xray['inbounds']})
            active = self.root / 'bridge.json'
            os.replace(candidate, active)
            if xray['inbounds']:
                self.process = subprocess.Popen([self.config['xray_binary'], 'run', '-config', str(active)], **self.child_args())
                try:
                    self.process.wait(timeout=0.35)
                    raise ConfigurationError('Bridge child exited during startup')
                except subprocess.TimeoutExpired:
                    pass
            self.last_config = copy.deepcopy(xray)
            print(f'Bridge configuration applied: {len(xray["inbounds"])} active entrances.', flush=True)
        elif registry != self.registry:
            atomic_json(self.registry_path, registry)
            self.registry = registry
        with self.lock:
            self.documents = documents
        # Contains only nonsensitive deployment information; useful for exact firewall review.
        atomic_json(self.root / 'active-ports.json', {'ports': sorted(i['port'] for i in xray['inbounds'])}, 0o644)

    def run(self):
        while not self.stopping.is_set():
            started = time.monotonic()
            try:
                self.synchronize()
            except Exception:
                # No exception repr/traceback: libraries may embed URLs, UUIDs or credentials.
                print('Synchronization failed; browser bridge paused. Check local configuration and panel availability.', flush=True)
                self.fail_closed()
            remaining = max(1, self.config['sync_seconds'] - (time.monotonic() - started))
            deadline = time.monotonic() + remaining
            while not self.stopping.wait(min(1, max(0, deadline - time.monotonic()))):
                if self.process is not None and self.process.poll() is not None:
                    self.fail_closed()
                    break
                if time.monotonic() >= deadline:
                    break
        self.fail_closed()


class Adapter(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, supervisor):
        self.supervisor = supervisor
        self.slots = threading.BoundedSemaphore(32)
        super().__init__(('127.0.0.1', supervisor.config['listen_port']), Handler)

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        pass


class Handler(BaseHTTPRequestHandler):
    server_version = 'SubscriptionAdapter'
    sys_version = ''

    def setup(self):
        self.request.settimeout(8)
        super().setup()

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.serve(False)

    def do_HEAD(self):
        self.serve(True)

    def serve(self, head):
        supervisor = self.server.supervisor
        path = urlsplit(self.path)
        prefix = supervisor.config['clash_path_prefix']
        token = path.path[len(prefix):] if path.path.startswith(prefix) else ''
        with supervisor.lock:
            item = supervisor.documents.get(token) if token and not path.query and not path.fragment else None
        if item is None:
            self.send_response(404)
            body = b'Subscription unavailable\n'
            headers = {}
        else:
            self.send_response(200)
            body, headers = item
        self.send_header('Content-Type', 'application/yaml; charset=utf-8')
        self.send_header('Cache-Control', 'no-store, private')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Length', str(len(body)))
        for name, value in headers.items():
            self.send_header(name, value)
        self.end_headers()
        if not head:
            self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        supervisor = Supervisor(load_config(args.config))
        # Never permit two supervisors to race on the persistent port registry.
        import fcntl
        lock = open(supervisor.root / 'service.lock', 'a')
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        server = Adapter(supervisor)
        for signum in (signal.SIGTERM, signal.SIGINT):
            signal.signal(signum, lambda *_: supervisor.stopping.set())
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            supervisor.run()
        finally:
            server.shutdown()
            server.server_close()
    except Exception:
        print('Service startup failed. Check deployment configuration and permissions.', flush=True)
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
