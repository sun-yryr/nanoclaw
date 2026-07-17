import http from 'http';
import type { AddressInfo } from 'net';

import { afterEach, describe, expect, it } from 'vitest';

import { synthesizeLocalVoice, type LocalVoiceOpenAIConfig } from './channels/local-voice-openai.js';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function startServer(body: Buffer): Promise<string> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'audio/wav',
      'content-length': String(body.length),
    });
    response.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe('local voice OpenAI response limits', () => {
  it('rejects an oversized TTS response before buffering it', async () => {
    const baseUrl = await startServer(Buffer.alloc(32, 1));
    const config: LocalVoiceOpenAIConfig = {
      apiKey: 'test-only',
      baseUrl,
      sttModel: 'test-stt',
      ttsModel: 'test-tts',
      ttsVoice: 'test-voice',
    };

    await expect(synthesizeLocalVoice('hello', config, { maxResponseBytes: 16 })).rejects.toThrow('exceeds 16 bytes');
  });

  it('passes cancellation through to STT requests', async () => {
    const config: LocalVoiceOpenAIConfig = {
      apiKey: 'test-only',
      baseUrl: 'http://127.0.0.1:1',
      sttModel: 'test-stt',
      ttsModel: 'test-tts',
      ttsVoice: 'test-voice',
    };

    await expect(synthesizeLocalVoice('hello', config, { signal: AbortSignal.abort() })).rejects.toThrow();
  });
});
