/**
 * Upload video files to Moonshot Files API and return an ms:// reference.
 *
 * OpenCode Zen/Go gateways (opencode.ai/zen/...) proxy chat completions only —
 * POST {base}/files returns 404. When the chat base URL is an OpenCode gateway,
 * uploads go to Moonshot directly (MOONSHOT_API_BASE_URL or api.moonshot.ai/v1).
 */

const DEFAULT_MOONSHOT_FILES_BASE = 'https://api.moonshot.ai/v1';

function log(msg: string): void {
  console.error(`[kimi-files-upload] ${msg}`);
}

export interface UploadVideoResult {
  url: string;
  fileId: string;
}

/** Resolve the Moonshot /files base URL for video uploads. */
export function resolveKimiFilesBaseUrl(chatBaseUrl?: string): string {
  const configured = process.env.MOONSHOT_API_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/, '');

  const chat = (chatBaseUrl ?? process.env.ANTHROPIC_BASE_URL ?? '').replace(/\/$/, '');
  if (chat && /opencode\.ai/i.test(chat)) {
    log(`Chat base is OpenCode gateway (${chat}); using Moonshot Files API at ${DEFAULT_MOONSHOT_FILES_BASE}`);
    return DEFAULT_MOONSHOT_FILES_BASE;
  }

  if (chat) return chat;
  return DEFAULT_MOONSHOT_FILES_BASE;
}

function resolveKimiFilesApiKey(): string {
  return process.env.MOONSHOT_API_KEY || process.env.OPENCODE_GO_API_KEY || 'placeholder';
}

export async function uploadVideoToKimi(
  data: Buffer,
  filename: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UploadVideoResult> {
  const baseUrl = resolveKimiFilesBaseUrl();
  const apiKey = resolveKimiFilesApiKey();

  const form = new FormData();
  form.append('purpose', 'video');
  form.append('file', new Blob([new Uint8Array(data)]), filename);

  const res = await fetchImpl(`${baseUrl}/files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Kimi file upload failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as { id?: string };
  if (!json.id) {
    throw new Error('Kimi file upload response missing id');
  }

  log(`Uploaded video ${filename} → ${json.id}`);
  return { fileId: json.id, url: `ms://${json.id}` };
}
