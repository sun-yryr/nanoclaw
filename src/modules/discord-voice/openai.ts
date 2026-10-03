import { Blob } from 'buffer';

export interface OpenAIAudioConfig {
  apiKey: string;
  baseUrl: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  judgeModel: string;
}

export async function transcribeWithOpenAI(audioWav: Buffer, config: OpenAIAudioConfig): Promise<string> {
  const form = new FormData();
  form.append('model', config.sttModel);
  form.append('file', new Blob([audioWav], { type: 'audio/wav' }), 'discord-voice.wav');

  const response = await fetch(`${config.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: form,
  });

  if (!response.ok) {
    throw new Error(`OpenAI transcription failed: ${response.status} ${await response.text()}`);
  }

  const json = (await response.json()) as { text?: unknown };
  return typeof json.text === 'string' ? json.text.trim() : '';
}

export async function synthesizeWithOpenAI(text: string, config: OpenAIAudioConfig): Promise<Buffer> {
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
  });

  if (!response.ok) {
    throw new Error(`OpenAI speech synthesis failed: ${response.status} ${await response.text()}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

export async function judgeVoiceResponseWithOpenAI(
  transcript: string,
  config: OpenAIAudioConfig,
  speakerName?: string,
): Promise<{ respond: boolean; reason?: string }> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.judgeModel,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You decide whether a voice assistant should speak in a casual Discord voice conversation. ' +
            'Return JSON only: {"respond": boolean, "reason": string}. Say respond=true only when the ' +
            'speaker explicitly asks the assistant, asks a question the assistant can help with, or the ' +
            'assistant can add clearly useful context. Say false for backchannels, jokes, casual chatter, ' +
            'or human-to-human remarks.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            speaker: speakerName ?? 'unknown',
            transcript,
          }),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI response judge failed: ${response.status} ${await response.text()}`);
  }

  const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content;
  if (!content) return { respond: false };

  try {
    const parsed = JSON.parse(content) as { respond?: unknown; reason?: unknown };
    return {
      respond: parsed.respond === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    };
  } catch {
    return { respond: false };
  }
}
