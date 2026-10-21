"""Loopback-only browser proxy. Keep OneCLI proxy credentials out of URLs seen by Chromium."""
import base64
import json
import select
import socket
import socketserver
from urllib.parse import urlsplit, unquote

with open('/run/nanoclaw-gui/upstream.json', encoding='utf-8') as f:
    upstream = urlsplit(json.load(f)['proxy'])
if upstream.scheme != 'http' or not upstream.hostname:
    raise SystemExit('Unsupported upstream proxy')
credentials = base64.b64encode((unquote(upstream.username or '') + ':' + unquote(upstream.password or '')).encode()).decode()

class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            self.request.settimeout(15)
            data = b''
            while b'\r\n\r\n' not in data:
                block = self.request.recv(4096)
                if not block or len(data) + len(block) > 65536:
                    return
                data += block
            head, body = data.split(b'\r\n\r\n', 1)
            lines = head.split(b'\r\n')
            filtered = [line for line in lines[1:] if line.split(b':', 1)[0].lower()
                        not in (b'proxy-authorization', b'proxy-connection', b'connection')]
            auth = ('Proxy-Authorization: Basic ' + credentials).encode()
            # HTTP (non-CONNECT) requests use one upstream connection per request.
            extra = [] if lines[0].startswith(b'CONNECT ') else [b'Connection: close', b'Proxy-Connection: close']
            with socket.create_connection((upstream.hostname, upstream.port or 80), timeout=15) as remote:
                remote.sendall(b'\r\n'.join([lines[0], *filtered, auth, *extra]) + b'\r\n\r\n' + body)
                sockets = [self.request, remote]
                while True:
                    ready, _, _ = select.select(sockets, [], [], 120)
                    if not ready:
                        return
                    for source in ready:
                        block = source.recv(65536)
                        if not block:
                            return
                        (remote if source is self.request else self.request).sendall(block)
        except (OSError, ValueError):
            # Never log headers, request bodies, destinations, or proxy tokens.
            return

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    def handle_error(self, request, client_address):
        pass

if __name__ == '__main__':
    Server(('127.0.0.1', 3128), Handler).serve_forever()
