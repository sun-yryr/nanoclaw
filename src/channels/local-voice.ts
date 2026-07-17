import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import {
  synthesizeLocalVoice,
  transcribeLocalVoice,
  type LocalVoiceOpenAIConfig,
  type LocalVoiceOpenAIRequestOptions,
} from './local-voice-openai.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const PROTOCOL_VERSION = 1;
const DEFAULT_PLATFORM_ID = 'local';
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;

interface LocalVoiceConfig {
  socketPath: string;
  openai: LocalVoiceOpenAIConfig;
  deliveryTimeoutMs: number;
  requestTimeoutMs: number;
  transcribe(
    audioWav: Buffer,
    config: LocalVoiceOpenAIConfig,
    options?: LocalVoiceOpenAIRequestOptions,
  ): Promise<string>;
  synthesize(text: string, config: LocalVoiceOpenAIConfig, options?: LocalVoiceOpenAIRequestOptions): Promise<Buffer>;
}

interface LocalVoiceFileConfig {
  enabled?: boolean;
  socketPath?: string;
  openaiBaseUrl?: string;
  sttModel?: string;
  ttsModel?: string;
  ttsVoice?: string;
  deliveryTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface ConnectedSidecar {
  socket: net.Socket;
  platformId: string | null;
}

interface PendingDelivery {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

type SidecarMessage =
  | { type: 'hello'; protocol: number; deviceId?: string }
  | { type: 'audio'; id: string; wavBase64: string }
  | { type: 'ack'; id: string }
  | { type: 'error'; id?: string; message?: string };

export function createLocalVoiceAdapter(config: LocalVoiceConfig): ChannelAdapter {
  let server: net.Server | null = null;
  let sidecar: ConnectedSidecar | null = null;
  let setup: ChannelSetup | null = null;
  let inboundQueue = Promise.resolve();
  const pendingDeliveries = new Map<string, PendingDelivery>();

  const adapter: ChannelAdapter = {
    name: 'local-voice',
    channelType: 'local-voice',
    supportsThreads: false,

    async setup(channelSetup): Promise<void> {
      setup = channelSetup;
      fs.mkdirSync(path.dirname(config.socketPath), { recursive: true, mode: 0o700 });
      removeSocketFile(config.socketPath);

      server = net.createServer(handleConnection);
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(config.socketPath, () => resolve());
      });
      fs.chmodSync(config.socketPath, 0o600);
      log.info('[local-voice] listening', { socketPath: config.socketPath });
    },

    async teardown(): Promise<void> {
      setup = null;
      disconnectSidecar(new Error('Local voice adapter stopped'));
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
      removeSocketFile(config.socketPath);
    },

    isConnected(): boolean {
      return server !== null && Boolean(sidecar?.platformId);
    },

    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      const current = sidecar;
      if (!current?.platformId || current.platformId !== platformId || current.socket.destroyed) {
        throw new Error(`Local voice sidecar is not connected for platform ${platformId}`);
      }

      const text = extractText(message);
      if (!text) return undefined;

      const audio = await config.synthesize(text, config.openai, {
        signal: AbortSignal.timeout(config.requestTimeoutMs),
        maxResponseBytes: MAX_AUDIO_BYTES,
      });

      const id = crypto.randomUUID();
      const delivered = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingDeliveries.delete(id);
          reject(new Error(`Local voice playback acknowledgement timed out for ${id}`));
        }, config.deliveryTimeoutMs);
        pendingDeliveries.set(id, { resolve, reject, timeout });
      });

      try {
        await writeJson(current.socket, {
          type: 'speak',
          id,
          wavBase64: audio.toString('base64'),
        });
        await delivered;
        return id;
      } catch (error) {
        rejectPending(id, error instanceof Error ? error : new Error(String(error)));
        await delivered.catch(() => undefined);
        throw error;
      }
    },
  };

  function handleConnection(socket: net.Socket): void {
    if (sidecar) {
      disconnectSidecar(new Error('Superseded by a newer local voice sidecar'));
    }
    sidecar = { socket, platformId: null };
    let buffer = '';

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) {
        socket.destroy(new Error('Local voice frame exceeds maximum size'));
        return;
      }

      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) handleLine(socket, line);
      }
    });
    socket.on('error', (error) => {
      log.warn('[local-voice] sidecar socket error', { error });
    });
    socket.on('close', () => {
      if (sidecar?.socket === socket) {
        disconnectSidecar(new Error('Local voice sidecar disconnected'));
      }
    });
  }

  function handleLine(socket: net.Socket, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      void writeJson(socket, { type: 'error', message: 'Malformed JSON' }).catch(() => undefined);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
      void writeJson(socket, { type: 'error', message: 'Message must be an object with a type' }).catch(
        () => undefined,
      );
      return;
    }
    const message = parsed as SidecarMessage;

    if (message.type === 'hello') {
      if (message.protocol !== PROTOCOL_VERSION) {
        void writeJson(socket, {
          type: 'error',
          message: `Unsupported protocol ${message.protocol}`,
        }).finally(() => socket.end());
        return;
      }
      if (sidecar?.socket !== socket) return;
      sidecar.platformId = normalizeDeviceId(message.deviceId);
      void writeJson(socket, {
        type: 'ready',
        protocol: PROTOCOL_VERSION,
        platformId: sidecar.platformId,
      });
      log.info('[local-voice] sidecar connected', { platformId: sidecar.platformId });
      return;
    }

    if (message.type === 'ack') {
      resolvePending(message.id);
      return;
    }

    if (message.type === 'error') {
      if (message.id) {
        rejectPending(message.id, new Error(message.message || 'Local voice sidecar reported an error'));
      }
      return;
    }

    if (message.type !== 'audio') return;
    const current = sidecar;
    if (!current || current.socket !== socket || !current.platformId) {
      void writeJson(socket, { type: 'error', id: message.id, message: 'hello is required before audio' });
      return;
    }
    if (!isValidAudioMessage(message)) {
      void writeJson(socket, { type: 'error', id: message.id, message: 'Invalid audio payload' });
      return;
    }

    const wav = Buffer.from(message.wavBase64, 'base64');
    if (wav.length === 0 || wav.length > MAX_AUDIO_BYTES) {
      void writeJson(socket, { type: 'error', id: message.id, message: 'Audio payload size is invalid' });
      return;
    }

    inboundQueue = inboundQueue
      .then(async () => {
        const transcript = await config.transcribe(wav, config.openai, {
          signal: AbortSignal.timeout(config.requestTimeoutMs),
        });
        if (!transcript || !setup) {
          await writeJson(socket, { type: 'accepted', id: message.id, empty: true });
          return;
        }
        await setup.onInbound(current.platformId!, null, {
          id: `local-voice-${message.id}`,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content: {
            text: transcript,
            sender: 'Local voice operator',
            senderId: 'local-voice:operator',
          },
          isMention: true,
          isGroup: false,
        });
        await writeJson(socket, { type: 'accepted', id: message.id });
      })
      .catch(async (error) => {
        log.warn('[local-voice] failed to process speech', { error });
        await writeJson(socket, {
          type: 'error',
          id: message.id,
          message: 'Speech processing failed',
        }).catch(() => undefined);
      });
  }

  function resolvePending(id: string): void {
    const pending = pendingDeliveries.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingDeliveries.delete(id);
    pending.resolve();
  }

  function rejectPending(id: string, error: Error): void {
    const pending = pendingDeliveries.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingDeliveries.delete(id);
    pending.reject(error);
  }

  function disconnectSidecar(error: Error): void {
    const current = sidecar;
    sidecar = null;
    if (current && !current.socket.destroyed) current.socket.destroy();
    for (const id of [...pendingDeliveries.keys()]) rejectPending(id, error);
  }

  return adapter;
}

function loadConfig(): LocalVoiceConfig | null {
  const fileConfig = readLocalVoiceFileConfig();
  const fileEnv = readEnvFile(['OPENAI_API_KEY']);
  const enabledOverride = process.env.LOCAL_VOICE_ENABLED;
  if (enabledOverride ? !parseBoolean(enabledOverride) : fileConfig?.enabled !== true) return null;

  const apiKey = process.env.OPENAI_API_KEY ?? fileEnv.OPENAI_API_KEY;
  if (!apiKey) {
    log.warn('[local-voice] OPENAI_API_KEY is required');
    return null;
  }

  const socketPath =
    process.env.LOCAL_VOICE_SOCKET_PATH ?? fileConfig?.socketPath ?? path.join(DATA_DIR, 'local-voice.sock');
  const deliveryTimeout =
    process.env.LOCAL_VOICE_DELIVERY_TIMEOUT_MS ??
    (fileConfig?.deliveryTimeoutMs === undefined ? undefined : String(fileConfig.deliveryTimeoutMs));
  const requestTimeout =
    process.env.LOCAL_VOICE_REQUEST_TIMEOUT_MS ??
    (fileConfig?.requestTimeoutMs === undefined ? undefined : String(fileConfig.requestTimeoutMs));
  return {
    socketPath: path.resolve(socketPath),
    deliveryTimeoutMs: parsePositiveInt(deliveryTimeout, 120_000),
    requestTimeoutMs: parsePositiveInt(requestTimeout, 60_000),
    openai: {
      apiKey,
      baseUrl: (
        process.env.LOCAL_VOICE_OPENAI_BASE_URL ??
        fileConfig?.openaiBaseUrl ??
        'https://api.openai.com/v1'
      ).replace(/\/$/, ''),
      sttModel: process.env.LOCAL_VOICE_STT_MODEL ?? fileConfig?.sttModel ?? 'gpt-4o-mini-transcribe',
      ttsModel: process.env.LOCAL_VOICE_TTS_MODEL ?? fileConfig?.ttsModel ?? 'gpt-4o-mini-tts',
      ttsVoice: process.env.LOCAL_VOICE_TTS_VOICE ?? fileConfig?.ttsVoice ?? 'alloy',
    },
    transcribe: transcribeLocalVoice,
    synthesize: synthesizeLocalVoice,
  };
}

function readLocalVoiceFileConfig(): LocalVoiceFileConfig | null {
  const configPath = path.join(DATA_DIR, 'local-voice', 'config.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as LocalVoiceFileConfig) : null;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('[local-voice] failed to read non-secret config', { configPath, error });
    }
    return null;
  }
}

function normalizeDeviceId(value: string | undefined): string {
  if (!value) return DEFAULT_PLATFORM_ID;
  return /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : DEFAULT_PLATFORM_ID;
}

function isValidAudioMessage(message: SidecarMessage): boolean {
  return (
    message.type === 'audio' &&
    typeof message.id === 'string' &&
    /^[A-Za-z0-9._-]{1,128}$/.test(message.id) &&
    typeof message.wavBase64 === 'string' &&
    message.wavBase64.length <= Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 4 &&
    message.wavBase64.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(message.wavBase64)
  );
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content.trim() || null;
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text.trim() || null;
    if (typeof content.markdown === 'string') return content.markdown.trim() || null;
  }
  return null;
}

function parseBoolean(value: string | undefined): boolean {
  return value ? ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()) : false;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function removeSocketFile(socketPath: string): void {
  try {
    fs.unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function writeJson(socket: net.Socket, payload: object): Promise<void> {
  if (!socket.writable || socket.destroyed) throw new Error('Local voice sidecar socket is not writable');
  await new Promise<void>((resolve, reject) => {
    socket.write(`${JSON.stringify(payload)}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

registerChannelAdapter('local-voice', {
  factory: () => {
    const config = loadConfig();
    return config ? createLocalVoiceAdapter(config) : null;
  },
});
