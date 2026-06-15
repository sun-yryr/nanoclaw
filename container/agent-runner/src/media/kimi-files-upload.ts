/**
 * Upload large video files to Moonshot Files API and return an ms:// reference.
 * Auth follows the same OneCLI proxy pattern as chat completions (placeholder
 * Bearer header rewritten on the wire).
 */

function log(msg: string): void {
  console.error(`[kimi-files-upload] ${msg}`);
}

export interface UploadVideoResult {
  url: string;
  fileId: string;
}

export async function uploadVideoToKimi(
  data: Buffer,
  filename: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UploadVideoResult> {
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.moonshot.ai/v1').replace(/\/$/, '');
  const apiKey = process.env.OPENCODE_GO_API_KEY || 'placeholder';

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
