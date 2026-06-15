/** MIME types Kimi vision accepts for inline image_url parts. */
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic']);

/** MIME types Kimi accepts for video_url parts. */
const VIDEO_MIMES = new Set([
  'video/mp4',
  'video/mpeg',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-flv',
  'video/mpg',
  'video/x-ms-wmv',
  'video/3gpp',
]);

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic']);
const VIDEO_EXTS = new Set(['mp4', 'mpeg', 'mov', 'avi', 'flv', 'mpg', 'webm', 'wmv', '3gpp']);

const IMAGE_TYPES = new Set(['image', 'photo', 'sticker']);
const VIDEO_TYPES = new Set(['video', 'animation']);

export type MediaKind = 'image' | 'video' | 'other';

export function extFromFilename(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  return name.slice(dot + 1).toLowerCase();
}

export function normalizeMime(mime: unknown): string {
  if (typeof mime !== 'string' || !mime) return '';
  return mime.split(';')[0].trim().toLowerCase();
}

export function classifyAttachment(att: Record<string, unknown>, filename: string): MediaKind {
  const mime = normalizeMime(att.mimeType);
  if (IMAGE_MIMES.has(mime)) return 'image';
  if (VIDEO_MIMES.has(mime)) return 'video';

  const ext = extFromFilename(filename);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';

  const coarse = typeof att.type === 'string' ? att.type.toLowerCase() : '';
  if (IMAGE_TYPES.has(coarse)) return 'image';
  if (VIDEO_TYPES.has(coarse)) return 'video';

  return 'other';
}

export function mimeForKind(kind: MediaKind, filename: string, declared?: string): string {
  const normalized = normalizeMime(declared);
  if (normalized) return normalized;
  const ext = extFromFilename(filename);
  if (kind === 'image') {
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'png') return 'image/png';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'heic') return 'image/heic';
    return 'image/jpeg';
  }
  if (kind === 'video') {
    if (ext === 'webm') return 'video/webm';
    if (ext === 'mov') return 'video/quicktime';
    if (ext === 'avi') return 'video/x-msvideo';
    return 'video/mp4';
  }
  return 'application/octet-stream';
}
