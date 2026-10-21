import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { startWatchServer, WatchTickets, WATCH_SCRIPT } from './watch.js';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function ticketFixture() {
  let now = 10_000;
  let token = 'host-only-root';
  let sequence = 0;
  const issue = vi.fn(async () => ({
    url: `http://internal/viewer/#ticket=readonly-${++sequence}`,
    expiresAtUnix: BigInt((now + 3600_000) / 1000),
  }));
  const tickets = new WatchTickets(
    async () => ({ endpoint: 'http://internal', token }),
    issue,
    () => now,
  );
  return {
    tickets,
    issue,
    advance: (ms: number) => {
      now += ms;
    },
    rotate: () => {
      token = 'new-host-only-root';
    },
  };
}
it('shares short-lived read-only tickets without revealing root credentials', async () => {
  const f = ticketFixture();
  const result = await Promise.all(Array.from({ length: 12 }, () => f.tickets.get()));
  expect(f.issue).toHaveBeenCalledTimes(1);
  expect(result.every((t) => t.url === result[0].url)).toBe(true);
  expect(JSON.stringify(result)).not.toContain('host-only-root');
  expect(result[0].url).toContain('view_only=1');
  expect(result[0].url).not.toContain('http://internal');
});
it('renews before expiry and reacquires immediately after control-token rotation', async () => {
  const f = ticketFixture();
  const first = await f.tickets.get();
  f.advance(3200_000);
  expect(await f.tickets.get()).toEqual(first);
  f.advance(200_000);
  expect(await f.tickets.get()).not.toEqual(first);
  f.rotate();
  const rotated = await f.tickets.get();
  expect(rotated.url).toContain('readonly-3');
  expect(f.issue).toHaveBeenCalledTimes(3);
});
it('does not return revoked tickets on failures and retries when spacesd recovers', async () => {
  const f = ticketFixture();
  await f.tickets.get();
  f.rotate();
  f.issue.mockRejectedValueOnce(new Error('spacesd restarting'));
  await expect(f.tickets.get()).rejects.toThrow('restarting');
  expect((await f.tickets.get()).url).toContain('readonly-2');
});
async function fixture() {
  const received: http.IncomingHttpHeaders[] = [];
  const backend = http.createServer((req, res) => {
    received.push(req.headers);
    res.setHeader('content-security-policy', "default-src 'self'; frame-ancestors 'none'");
    res.setHeader('access-control-allow-origin', '*');
    res.end('standard Cua viewer');
  });
  backend.on('upgrade', (req, socket, head) => {
    const key = crypto
      .createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\nSec-WebSocket-Protocol: rcdp.v2\r\n\r\n`,
    );
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  cleanup.push(() => new Promise<void>((resolve) => backend.close(() => resolve())));
  const tickets = ticketFixture().tickets;
  const server = await startWatchServer({
    host: '127.0.0.1',
    port: 0,
    tickets,
    endpoint: async () => `http://127.0.0.1:${(backend.address() as net.AddressInfo).port}`,
  });
  cleanup.push(() => server.close());
  return { server, received };
}
it('serves a fixed watch page and proxies the authenticated standard viewer', async () => {
  const { server, received } = await fixture();
  const page = await fetch(server.origin);
  expect(await page.text()).toContain('<iframe');
  expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  const session = await fetch(`${server.origin}/viewer-session`);
  expect(session.headers.get('cache-control')).toBe('no-store');
  expect(((await session.json()) as { url: string }).url).toContain('view_only=1');
  const viewer = await fetch(`${server.origin}/viewer/`, {
    headers: { 'x-cua-env-authorization': 'Bearer readonly', cookie: 'unrelated=value' },
  });
  expect(await viewer.text()).toBe('standard Cua viewer');
  expect(viewer.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
  expect(viewer.headers.get('access-control-allow-origin')).toBeNull();
  expect(received[0]['x-cua-env-authorization']).toBe('Bearer readonly');
  expect(received[0].cookie).toBeUndefined();
});
it('rejects cross-origin requests and forged Host values; exposes no control-minting API', async () => {
  const { server } = await fixture();
  expect(
    (await fetch(`${server.origin}/viewer-session`, { headers: { Origin: 'https://other.example' } })).status,
  ).toBe(403);
  expect((await fetch(`${server.origin}/viewer-session`, { method: 'POST', body: '{"control":true}' })).status).toBe(
    405,
  );
  const status = await new Promise<number | undefined>((resolve, reject) => {
    http
      .get(`${server.origin}/viewer-session`, { headers: { Host: 'other.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
      .on('error', reject);
  });
  expect(status).toBe(403);
});
it('preserves WebSocket upgrade negotiation and binary stream bytes', async () => {
  const { server } = await fixture();
  const target = new URL(server.origin);
  const socket = net.connect(Number(target.port), '127.0.0.1');
  cleanup.push(() => socket.destroy());
  await once(socket, 'connect');
  socket.write(
    `GET /stream HTTP/1.1\r\nHost: ${target.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: rcdp.v2\r\n\r\n`,
  );
  const handshake = (await once(socket, 'data'))[0].toString();
  expect(handshake).toContain('101 Switching Protocols');
  expect(handshake).toContain('rcdp.v2');
  const response = once(socket, 'data');
  const bytes = Buffer.from([0, 1, 128, 255]);
  socket.write(bytes);
  expect((await response)[0]).toEqual(bytes);
});
it('the fixed page reconnects on renewed tickets and recovers without reloading its URL', async () => {
  let interval!: () => void;
  let link = '/viewer/#ticket=first';
  let fail = false;
  const frame = { src: '' };
  const status = { hidden: false, textContent: '' };
  const document = { querySelector: (s: string) => (s === 'iframe' ? frame : status), addEventListener() {} };
  const fetch = vi.fn(async () => {
    if (fail) throw Error('offline');
    return { ok: true, json: async () => ({ url: link }) };
  });
  runInNewContext(WATCH_SCRIPT, {
    AbortSignal,
    document,
    fetch,
    setInterval: (cb: () => void) => {
      interval = cb;
    },
  });
  await vi.waitFor(() => expect(frame.src).toBe(link));
  fail = true;
  interval();
  await vi.waitFor(() => expect(status.hidden).toBe(false));
  fail = false;
  link = '/viewer/#ticket=renewed';
  interval();
  await vi.waitFor(() => expect(frame.src).toBe(link));
  expect(status.hidden).toBe(true);
});
