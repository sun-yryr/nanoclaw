/** Host/runner wire contract. Copied into the runner; never imports host code. */
export type GuiInput =
  | { kind: 'click' | 'double_click'; x: number; y: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; keys: string[] }
  | { kind: 'scroll'; dx: number; dy: number }
  | { kind: 'drag'; x: number; y: number; toX: number; toY: number };
export type GuiOperation =
  | { kind: 'acquire'; owner: string }
  | { kind: 'observe'; lease: string }
  | { kind: 'release'; lease: string }
  | { kind: 'act'; lease: string; observation: string; input: GuiInput };
export interface GuiRequest {
  action: 'gui_request';
  requestId: string;
  deadline: number;
  operation: GuiOperation;
}
export interface GuiScreen {
  data: string;
  mediaType: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
  observation: string;
}
export type GuiResponse =
  | { ok: true; lease?: string; screen?: GuiScreen }
  | { ok: false; code: 'busy' | 'disabled' | 'invalid' | 'expired' | 'unavailable' };
export const GUI_MAX_IMAGE_BYTES = 512 * 1024;
export const GUI_LEASE_MS = 330_000;
export const GUI_REQUEST_MS = 25_000;
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(v);
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 32768;
export function validGuiRequest(value: unknown, now = Date.now()): value is GuiRequest {
  if (!value || typeof value !== 'object') return false;
  const r = value as GuiRequest;
  if (
    r.action !== 'gui_request' ||
    !id(r.requestId) ||
    !Number.isSafeInteger(r.deadline) ||
    r.deadline <= now ||
    r.deadline > now + GUI_REQUEST_MS + 1000 ||
    !r.operation ||
    typeof r.operation !== 'object' ||
    Array.isArray(r.operation)
  )
    return false;
  const op = r.operation;
  if (op.kind === 'acquire') return id(op.owner);
  if (!('lease' in op) || !id(op.lease)) return false;
  if (op.kind === 'release' || op.kind === 'observe') return true;
  if (op.kind !== 'act' || !id(op.observation) || !op.input) return false;
  const a = op.input;
  switch (a.kind) {
    case 'click':
    case 'double_click':
      return number(a.x) && number(a.y) && a.x >= 0 && a.y >= 0;
    case 'drag':
      return [a.x, a.y, a.toX, a.toY].every((v) => number(v) && v >= 0);
    case 'scroll':
      return number(a.dx) && number(a.dy) && Math.abs(a.dx) <= 100 && Math.abs(a.dy) <= 100;
    case 'type':
      return typeof a.text === 'string' && a.text.length <= 8000;
    case 'key':
      return (
        Array.isArray(a.keys) &&
        a.keys.length > 0 &&
        a.keys.length <= 5 &&
        a.keys.every((k) => typeof k === 'string' && /^[A-Za-z0-9_+-]{1,32}$/.test(k))
      );
    default:
      return false;
  }
}
