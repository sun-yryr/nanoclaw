export interface VoiceDecisionInput {
  transcript: string;
  speakerName?: string;
  botNames?: string[];
  probability: number;
  random?: () => number;
  aiJudge?: (input: VoiceJudgeInput) => Promise<VoiceJudgeResult>;
}

export interface VoiceJudgeInput {
  transcript: string;
  speakerName?: string;
}

export interface VoiceJudgeResult {
  respond: boolean;
  reason?: string;
}

export interface VoiceDecision {
  respond: boolean;
  reason: 'empty' | 'explicit' | 'ai_judge' | 'probability' | 'probability_miss';
  detail?: string;
}

const EXPLICIT_REQUEST_PATTERNS = [
  /\?/,
  /？/,
  /\b(ai|assistant|bot|nanoclaw|nano claw)\b/i,
  /\b(hey|ok|okay)\s+(assistant|bot|ai|nanoclaw)\b/i,
  /\b(can you|could you|would you|please|tell me|explain|what do you think)\b/i,
  /(答えて|教えて|説明して|どう思う|質問|お願い|返事して|反応して|ナノクロウ|エーアイ|AI)/i,
];

export function normalizeProbability(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function hasExplicitResponseRequest(transcript: string, botNames: string[] = []): boolean {
  const text = transcript.trim();
  if (!text) return false;

  const lower = text.toLowerCase();
  for (const name of botNames) {
    const normalized = name.trim().toLowerCase();
    if (normalized && lower.includes(normalized)) return true;
  }

  return EXPLICIT_REQUEST_PATTERNS.some((pattern) => pattern.test(text));
}

export async function decideVoiceResponse(input: VoiceDecisionInput): Promise<VoiceDecision> {
  const transcript = input.transcript.trim();
  if (!transcript) {
    return { respond: false, reason: 'empty' };
  }

  if (hasExplicitResponseRequest(transcript, input.botNames)) {
    return { respond: true, reason: 'explicit' };
  }

  if (input.aiJudge) {
    try {
      const judged = await input.aiJudge({ transcript, speakerName: input.speakerName });
      if (judged.respond) {
        return { respond: true, reason: 'ai_judge', detail: judged.reason };
      }
    } catch {
      // Fall back to probability when the judge is unavailable.
    }
  }

  const probability = normalizeProbability(input.probability);
  const roll = (input.random ?? Math.random)();
  if (roll < probability) {
    return { respond: true, reason: 'probability', detail: `${roll.toFixed(4)} < ${probability}` };
  }
  return { respond: false, reason: 'probability_miss', detail: `${roll.toFixed(4)} >= ${probability}` };
}
