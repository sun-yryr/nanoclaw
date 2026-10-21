import crypto from 'node:crypto';
import { GUI_LEASE_MS, type GuiInput, type GuiRequest, type GuiResponse, type GuiScreen } from './protocol.js';
export interface GuiTransport {
  observe(signal: AbortSignal): Promise<Omit<GuiScreen, 'observation'>>;
  act(input: GuiInput, signal: AbortSignal): Promise<void>;
}
interface Lease {
  id: string;
  session: string;
  owner: string;
  expires: number;
  observedTransport?: GuiTransport;
  screen?: { id: string; width: number; height: number; at: number };
}
/** One desktop per group. Restart forgets leases, never deletes desktops. */
export class GuiManager {
  private paused = new Set<string>();
  private stopped = false;
  private shutdown = new AbortController();
  async pause(group: string): Promise<void> {
    this.paused.add(group);
    await this.queues.get(group)?.catch(() => {});
    this.leases.delete(group);
  }
  resume(group: string): void {
    this.paused.delete(group);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.shutdown.abort();
    await Promise.allSettled([...this.queues.values()]);
    this.leases.clear();
  }
  private leases = new Map<string, Lease>();
  private queues = new Map<string, Promise<unknown>>();
  private responses = new Map<string, { expires: number; response: Promise<GuiResponse> }>();
  constructor(
    private transport: (group: string) => Promise<GuiTransport>,
    private now = Date.now,
  ) {}
  request(group: string, session: string, request: GuiRequest): Promise<GuiResponse> {
    for (const [key, item] of this.responses) if (item.expires <= this.now()) this.responses.delete(key);
    const key = `${group}:${session}:${request.requestId}`;
    const existing = this.responses.get(key);
    if (existing) return existing.response;
    // Bound outstanding and retained image responses; refuse instead of evicting deduplication records.
    if (this.responses.size >= 64) return Promise.resolve({ ok: false, code: 'busy' });
    const previous = this.queues.get(group) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(() => this.execute(group, session, request));
    this.queues.set(group, result);
    void result.finally(() => {
      if (this.queues.get(group) === result) this.queues.delete(group);
    });
    this.responses.set(key, { expires: request.deadline + 1000, response: result });
    return result;
  }
  private async execute(group: string, session: string, request: GuiRequest): Promise<GuiResponse> {
    if (this.stopped || this.paused.has(group)) return { ok: false, code: 'unavailable' };
    if (request.deadline <= this.now()) return { ok: false, code: 'expired' };
    let lease = this.leases.get(group);
    if (lease && lease.expires <= this.now()) {
      this.leases.delete(group);
      lease = undefined;
    }
    const op = request.operation;
    if (op.kind === 'acquire') {
      if (lease)
        return lease.session === session && lease.owner === op.owner
          ? { ok: true, lease: lease.id }
          : { ok: false, code: 'busy' };
      const next = { id: crypto.randomUUID(), session, owner: op.owner, expires: this.now() + GUI_LEASE_MS };
      this.leases.set(group, next);
      return { ok: true, lease: next.id };
    }
    if (!lease || lease.id !== op.lease || lease.session !== session) return { ok: false, code: 'expired' };
    if (op.kind === 'release') {
      this.leases.delete(group);
      return { ok: true };
    }
    const signal = AbortSignal.any([
      this.shutdown.signal,
      AbortSignal.timeout(Math.max(1, Math.min(request.deadline, lease.expires) - this.now())),
    ]);
    try {
      const transport = await this.transport(group);
      signal.throwIfAborted();
      if (op.kind === 'observe') {
        const screen = await transport.observe(signal);
        signal.throwIfAborted();
        const observation = crypto.randomUUID();
        lease.observedTransport = transport;
        lease.screen = { id: observation, width: screen.width, height: screen.height, at: this.now() };
        return { ok: true, screen: { ...screen, observation } };
      }
      const screen = lease.screen;
      if (!screen || screen.id !== op.observation || this.now() - screen.at > 60_000)
        return { ok: false, code: 'expired' };
      const input = op.input;
      if (
        'x' in input &&
        (input.x >= screen.width ||
          input.y >= screen.height ||
          ('toX' in input && (input.toX >= screen.width || input.toY >= screen.height)))
      )
        return { ok: false, code: 'invalid' };
      // Consume observation before the write. An uncertain write must never be retried blindly.
      lease.screen = undefined;
      await (lease.observedTransport ?? transport).act(input, signal);
      lease.observedTransport = undefined;
      signal.throwIfAborted();
      return { ok: true };
      // eslint-disable-next-line no-catch-all/no-catch-all -- external GUI failures are intentionally reduced to a secret-free protocol error
    } catch {
      // Keep the lease until an in-flight call actually settles; another worker must not race it.
      lease.screen = undefined;
      return { ok: false, code: 'unavailable' };
    }
  }
}
