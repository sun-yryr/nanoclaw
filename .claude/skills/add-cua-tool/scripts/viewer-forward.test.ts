import net from 'node:net';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { forwardViewer } from './viewer-forward.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
async function listen() {
  const server = net.createServer((socket) => {
    cleanups.push(() => socket.destroy());
    socket.pipe(socket);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(() => server.close());
  return { server, port: (server.address() as net.AddressInfo).port };
}
async function unusedPort() {
  const { server, port } = await listen();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
it('forwards binary stream bytes unchanged over the loopback listener', async () => {
  const { port } = await listen();
  const local = await unusedPort();
  const relay = await forwardViewer(`http://127.0.0.1:${port}`, local, 10_000);
  cleanups.push(relay.close);
  const client = net.connect(local, '127.0.0.1');
  cleanups.push(() => client.destroy());
  await once(client, 'connect');
  const data = once(client, 'data');
  const payload = Buffer.from([0, 1, 127, 128, 254, 255]);
  client.write(payload);
  expect((await data)[0]).toEqual(payload);
});
it('expires the listener and disconnects existing streams', async () => {
  const { port } = await listen();
  const local = await unusedPort();
  const relay = await forwardViewer(`http://127.0.0.1:${port}`, local, 1000);
  cleanups.push(relay.close);
  const client = net.connect(local, '127.0.0.1');
  cleanups.push(() => client.destroy());
  await once(client, 'connect');
  await once(client, 'close');
  const next = net.connect(local, '127.0.0.1');
  cleanups.push(() => next.destroy());
  expect((await once(next, 'error'))[0]).toMatchObject({ code: 'ECONNREFUSED' });
});
it('refuses an occupied port without changing the existing listener', async () => {
  const { port, server } = await listen();
  await expect(forwardViewer(`http://127.0.0.1:${port}`, port, 1000)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  expect(server.listening).toBe(true);
});
