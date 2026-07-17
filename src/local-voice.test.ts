import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import { createLocalVoiceAdapter } from './channels/local-voice.js';

interface TestClient {
  socket: net.Socket;
  next(): Promise<Record<string, unknown>>;
  send(payload: object): void;
}

const adapters: ChannelAdapter[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.teardown()));
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function createHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-local-voice-'));
  tempDirs.push(dir);
  const socketPath = path.join(dir, 'voice.sock');
  const onInbound = vi.fn(async () => undefined);
  const transcribe = vi.fn(async () => 'What time is it?');
  const synthesize = vi.fn(async () => Buffer.from('RIFF-test-audio'));
  const adapter = createLocalVoiceAdapter({
    socketPath,
    deliveryTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    openai: {
      apiKey: 'test-only',
      baseUrl: 'http://127.0.0.1',
      sttModel: 'test-stt',
      ttsModel: 'test-tts',
      ttsVoice: 'test-voice',
    },
    transcribe,
    synthesize,
  });
  adapters.push(adapter);

  const setup: ChannelSetup = {
    onInbound,
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
    onAction: vi.fn(),
  };
  return { adapter, setup, socketPath, onInbound, transcribe, synthesize };
}

async function connect(socketPath: string, deviceId = 'local'): Promise<TestClient> {
  const socket = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<(message: Record<string, unknown>) => void> = [];
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else messages.push(message);
    }
  });

  const client: TestClient = {
    socket,
    next: async () => {
      const queued = messages.shift();
      if (queued) return queued;
      return new Promise<Record<string, unknown>>((resolve) => waiters.push(resolve));
    },
    send: (payload) => socket.write(`${JSON.stringify(payload)}\n`),
  };
  client.send({ type: 'hello', protocol: 1, deviceId });
  expect(await client.next()).toMatchObject({ type: 'ready', platformId: deviceId });
  return client;
}

describe('local voice channel adapter', () => {
  it('transcribes bounded audio and routes a mentioned DM', async () => {
    const harness = createHarness();
    await harness.adapter.setup(harness.setup);
    expect(fs.statSync(harness.socketPath).mode & 0o777).toBe(0o600);
    const client = await connect(harness.socketPath, 'desk');

    client.send({
      type: 'audio',
      id: 'turn-1',
      wavBase64: Buffer.from('RIFF-input').toString('base64'),
    });

    expect(await client.next()).toMatchObject({ type: 'accepted', id: 'turn-1' });
    expect(harness.transcribe).toHaveBeenCalledOnce();
    expect(harness.onInbound).toHaveBeenCalledWith(
      'desk',
      null,
      expect.objectContaining({
        id: 'local-voice-turn-1',
        isMention: true,
        isGroup: false,
        content: expect.objectContaining({
          text: 'What time is it?',
          senderId: 'local-voice:operator',
        }),
      }),
    );
    client.socket.destroy();
  });

  it('synthesizes outbound text and waits for playback acknowledgement', async () => {
    const harness = createHarness();
    await harness.adapter.setup(harness.setup);
    const client = await connect(harness.socketPath);

    const delivery = harness.adapter.deliver('local', null, {
      kind: 'chat',
      content: { text: 'It is noon.' },
    });
    const speak = await client.next();
    expect(speak).toMatchObject({ type: 'speak' });
    expect(Buffer.from(speak.wavBase64 as string, 'base64').toString()).toBe('RIFF-test-audio');
    client.send({ type: 'ack', id: speak.id });

    await expect(delivery).resolves.toBe(speak.id);
    expect(harness.synthesize).toHaveBeenCalledWith(
      'It is noon.',
      expect.objectContaining({ ttsModel: 'test-tts' }),
      expect.objectContaining({ maxResponseBytes: 2 * 1024 * 1024 }),
    );
    client.socket.destroy();
  });

  it('rejects delivery when the sidecar is disconnected', async () => {
    const harness = createHarness();
    await harness.adapter.setup(harness.setup);

    await expect(
      harness.adapter.deliver('local', null, {
        kind: 'chat',
        content: { text: 'Hello' },
      }),
    ).rejects.toThrow('not connected');
  });

  it('rejects an old playback when a new sidecar supersedes it', async () => {
    const harness = createHarness();
    await harness.adapter.setup(harness.setup);
    const first = await connect(harness.socketPath);
    const delivery = harness.adapter.deliver('local', null, {
      kind: 'chat',
      content: { text: 'Old reply' },
    });
    const rejected = expect(delivery).rejects.toThrow('Superseded');
    expect(await first.next()).toMatchObject({ type: 'speak' });

    const second = await connect(harness.socketPath);

    await rejected;
    first.socket.destroy();
    second.socket.destroy();
  });

  it('requires a valid handshake before accepting audio', async () => {
    const harness = createHarness();
    await harness.adapter.setup(harness.setup);
    const socket = net.createConnection(harness.socketPath);
    await new Promise<void>((resolve) => socket.once('connect', resolve));

    let response = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      response += chunk;
    });
    socket.write(
      `${JSON.stringify({
        type: 'audio',
        id: 'turn-2',
        wavBase64: Buffer.from('RIFF-input').toString('base64'),
      })}\n`,
    );
    await vi.waitFor(() => expect(response).toContain('hello is required'));
    expect(harness.transcribe).not.toHaveBeenCalled();
    socket.destroy();
  });
});
