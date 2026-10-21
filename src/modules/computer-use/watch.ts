import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Duplex } from 'node:stream';

export interface ViewerState {
  endpoint: string;
  token: string;
}
export interface ViewerLink {
  url: string;
  expiresAtUnix: number | bigint;
}
export interface WatchTicket {
  url: string;
  expiresAt: number;
}

/** Root credentials stay here; browsers receive only renewable view-only tickets. */
export class WatchTickets {
  private cached?: { state: ViewerState; ticket: WatchTicket };
  private pending?: Promise<WatchTicket>;
  constructor(
    private load: () => Promise<ViewerState>,
    private issue: (state: ViewerState) => Promise<ViewerLink>,
    private now = Date.now,
  ) {}
  async get(): Promise<WatchTicket> {
    const state = await this.load();
    const cached = this.cached;
    if (
      cached &&
      cached.state.token === state.token &&
      cached.state.endpoint === state.endpoint &&
      cached.ticket.expiresAt > this.now() + 300_000
    )
      return cached.ticket;
    if (this.pending) return this.pending;
    const pending = (async () => {
      const link = await this.issue(state);
      const url = new URL(link.url);
      const ticket = new URLSearchParams(url.hash.slice(1)).get('ticket');
      const expiresAt = Number(link.expiresAtUnix) * 1000;
      if (!ticket || !Number.isSafeInteger(expiresAt) || expiresAt <= this.now() + 300_000)
        throw new Error('Invalid viewer ticket');
      const fragment = new URLSearchParams({ ticket, view_only: '1', clipboard: '0', audio: 'none' });
      const result = { url: `/viewer/#${fragment}`, expiresAt };
      this.cached = { state, ticket: result };
      return result;
    })();
    this.pending = pending;
    try {
      return await pending;
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }
}

const PAGE = `<!doctype html><html lang="ja"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NanoClaw Desktop</title><link rel="icon" href="data:,">
<style>html,body{margin:0;width:100%;height:100%;background:#141719;color:#eee;font:16px system-ui}
iframe{width:100%;height:100%;border:0;display:block}p{position:fixed;top:0;left:0;padding:12px;background:#141719}</style>
<iframe title="デスクトップ（閲覧専用）" allow="autoplay; fullscreen"></iframe>
<p role="status">画面に接続しています…</p><script src="/watch.js" defer></script></html>`;
export const WATCH_SCRIPT = `const frame=document.querySelector('iframe'),status=document.querySelector('[role=status]');
let current='',pending=false;
async function refresh(){
  if(pending)return;pending=true;
  try{
    const response=await fetch('/viewer-session',{cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw Error();
    const ticket=await response.json();
    if(typeof ticket.url!=='string'||!ticket.url.startsWith('/viewer/#'))throw Error();
    if(ticket.url!==current){frame.src=ticket.url;current=ticket.url;}
    status.hidden=true;
  }catch{status.textContent='画面に再接続しています…';status.hidden=false;}
  finally{pending=false;}
}
refresh();setInterval(refresh,5000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});`;

export interface WatchServerOptions {
  host: string;
  port: number;
  tls?: { cert: Buffer; key: Buffer };
  tickets: { get(): Promise<WatchTicket> };
  endpoint(): Promise<string>;
}

export function isPrivateIpv4(host: string): boolean {
  return net.isIP(host) === 4 && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

/** LAN trust is sufficient for watching. Cua still authenticates every RPC and stream. */
export async function startWatchServer(options: WatchServerOptions) {
  if ((!options.tls || !isPrivateIpv4(options.host)) && options.host !== '127.0.0.1')
    throw new Error('Viewer requires HTTPS on an explicit private IPv4 address');
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
    throw new Error('Invalid viewer port');
  const sockets = new Set<Duplex>();
  const upstream = new Set<http.ClientRequest>();
  const track = <T extends Duplex>(socket: T): T => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const authorized = (req: http.IncomingMessage) => {
    const address = server.address() as net.AddressInfo;
    if (!address) return false;
    const host = `${options.host}:${address.port}`;
    const origin = `${options.tls ? 'https' : 'http'}://${host}`;
    return req.headers.host === host && (!req.headers.origin || req.headers.origin === origin);
  };
  const headers = (req: http.IncomingMessage) => {
    // Keep the caller's Cua ticket; never inject the host's root token.
    const result = { ...req.headers };
    delete result.cookie;
    delete result.forwarded;
    for (const name of Object.keys(result)) if (name.startsWith('x-forwarded-')) delete result[name];
    return result;
  };
  const proxy = (req: http.IncomingMessage, endpoint: string) => {
    const target = new URL(endpoint);
    if (target.protocol !== 'http:') throw new Error('Expected a verified Cua HTTP endpoint');
    const request = http.request({
      hostname: target.hostname,
      port: target.port || 80,
      path: req.url,
      method: req.method,
      headers: headers(req),
    });
    upstream.add(request);
    request.once('close', () => upstream.delete(request));
    request.setTimeout(30_000, () => request.destroy());
    return request;
  };
  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!authorized(req)) {
      res.writeHead(403).end();
      return;
    }
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) {
      res.writeHead(400).end();
      return;
    }
    if (req.url === '/' || req.url === '/watch.js' || req.url === '/viewer-session') {
      if (req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET' }).end();
        return;
      }
      if (req.url === '/viewer-session') {
        const ticket = await options.tickets.get();
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(ticket));
        return;
      }
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      );
      res.writeHead(200, { 'Content-Type': req.url === '/' ? 'text/html; charset=utf-8' : 'text/javascript' });
      res.end(req.url === '/' ? PAGE : WATCH_SCRIPT);
      return;
    }
    const outgoing = proxy(req, await options.endpoint());
    req.once('aborted', () => outgoing.destroy());
    res.once('close', () => outgoing.destroy());
    outgoing.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    outgoing.on('response', (response) => {
      const responseHeaders: http.OutgoingHttpHeaders = { ...response.headers, 'cache-control': 'no-store' };
      // The standard viewer allows embedding only by this same-origin watch page.
      const csp = responseHeaders['content-security-policy'];
      if (typeof csp === 'string')
        responseHeaders['content-security-policy'] = csp.replace("frame-ancestors 'none'", "frame-ancestors 'self'");
      for (const name of Object.keys(responseHeaders))
        if (name.startsWith('access-control-') || name === 'set-cookie') delete responseHeaders[name];
      res.writeHead(response.statusCode ?? 502, responseHeaders);
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    req.pipe(outgoing);
  };
  const serve = (req: http.IncomingMessage, res: http.ServerResponse) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(503);
      res.end();
    });
  };
  const server = options.tls
    ? https.createServer({ ...options.tls, minVersion: 'TLSv1.2', handshakeTimeout: 10_000 }, serve)
    : http.createServer(serve);
  server.on('connection', track);
  server.on('upgrade', (req, socket, head) => {
    track(socket);
    socket.on('error', () => socket.destroy());
    if (!authorized(req) || !req.url?.startsWith('/') || req.url.startsWith('//')) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    void options
      .endpoint()
      .then((endpoint) => {
        if (socket.destroyed) return;
        const request = proxy(req, endpoint);
        socket.once('close', () => request.destroy());
        request.on('error', () => socket.destroy());
        request.on('response', (response) => {
          response.resume();
          socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        });
        request.on('upgrade', (response, peer, upstreamHead) => {
          track(peer);
          peer.setTimeout(0);
          peer.on('error', () => socket.destroy());
          peer.once('close', () => socket.destroy());
          socket.once('close', () => peer.destroy());
          const responseHeaders = Object.entries(response.headers).flatMap(([key, value]) =>
            value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((v) => `${key}: ${v}`),
          );
          socket.write(`HTTP/1.1 101 Switching Protocols\r\n${responseHeaders.join('\r\n')}\r\n\r\n`);
          if (upstreamHead.length) socket.write(upstreamHead);
          if (head.length) peer.write(head);
          socket.pipe(peer).pipe(socket);
        });
        request.end();
      })
      .catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return {
    origin: `${options.tls ? 'https' : 'http'}://${options.host}:${(server.address() as net.AddressInfo).port}`,
    async close() {
      const done = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const request of upstream) request.destroy();
      for (const socket of sockets) socket.destroy();
      await done;
    },
  };
}
