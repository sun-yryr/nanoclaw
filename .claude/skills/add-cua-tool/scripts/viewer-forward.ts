import net from 'node:net';
import tls from 'node:tls';

type ViewerTls = { host: string; cert: Buffer; key: Buffer };

/** Preserve Cua authentication over either local TCP or operator-configured LAN TLS. */
export async function forwardViewer(endpoint: string, port: number, lifetimeMs: number, secure?: ViewerTls) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Viewer port must be between 1 and 65535');
  if (secure && !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(secure.host))
    throw new Error('HTTPS viewer must bind an explicit private LAN IPv4 address');
  if (secure && net.isIP(secure.host) !== 4) throw new Error('Invalid LAN IPv4 address');
  const target = new URL(endpoint);
  if (target.protocol !== 'http:') throw new Error('Expected the verified HTTP Cua endpoint');
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const forward = (socket: net.Socket) => {
    const peer = track(net.connect({ host: target.hostname, port: Number(target.port || 80) }));
    socket.on('error', () => peer.destroy());
    peer.on('error', () => socket.destroy());
    socket.once('close', () => peer.destroy());
    peer.once('close', () => socket.destroy());
    socket.pipe(peer).pipe(socket);
  };
  const server = secure
    ? tls.createServer({ cert: secure.cert, key: secure.key, minVersion: 'TLSv1.2', handshakeTimeout: 10000 }, forward)
    : net.createServer(forward);
  // Include sockets that have not yet completed the TLS handshake in expiry cleanup.
  server.on('connection', track);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, secure?.host ?? '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const close = () => {
    clearTimeout(timer);
    server.close();
    for (const socket of sockets) socket.destroy();
  };
  const timer = setTimeout(close, lifetimeMs);
  timer.unref();
  server.on('error', close);
  return { origin: secure ? `https://${secure.host}:${port}` : `http://127.0.0.1:${port}`, close };
}
