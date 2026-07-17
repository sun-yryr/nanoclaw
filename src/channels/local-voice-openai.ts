import { Blob } from 'buffer';

export interface LocalVoiceOpenAIConfig {
  apiKey: string;
  baseUrl: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
}

export interface LocalVoiceOpenAIRequestOptions {
  signal?: AbortSignal;
  maxResponseBytes?: number;
}

export async function transcribeLocalVoice(
  audioWav: Buffer,
  config: LocalVoiceOpenAIConfig,
  options: LocalVoiceOpenAIRequestOptions = {},
): Promise<string> {
  const form = new FormData();
  form.append('model', config.sttModel);
  form.append('file', new Blob([audioWav], { type: 'audio/wav' }), 'local-voice.wav');

  const response = await fetch(`${config.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: form,
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`OpenAI transcription failed: ${response.status} ${await response.text()}`);
  }

  const json = (await response.json()) as { text?: unknown };
  return typeof json.text === 'string' ? json.text.trim() : '';
}

export async function synthesizeLocalVoice(
  text: string,
  config: LocalVoiceOpenAIConfig,
  options: LocalVoiceOpenAIRequestOptions = {},
): Promise<Buffer> {
  const response = await fetch(`${config.baseUrl}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.ttsModel,
      voice: config.ttsVoice,
      input: text,
      response_format: 'wav',
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`OpenAI speech synthesis failed: ${response.status} ${await response.text()}`);
  }

  return readBoundedResponse(response, options.maxResponseBytes);
}

async function readBoundedResponse(response: Response, maxBytes?: number): Promise<Buffer> {
  if (maxBytes === undefined) return Buffer.from(await response.arrayBuffer());

  const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`OpenAI speech response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return Buffer.alloc(0);

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`OpenAI speech response exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
