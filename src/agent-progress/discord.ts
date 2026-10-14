/** Persistent Components V2 cards. No collectors or long-lived interaction tokens. */
import { getDb } from '../db/connection.js';
import { getSession } from '../db/sessions.js';
import { withExistingMailboxSession } from '../session-manager.js';
import { getMessagingGroup, getMessagingGroupAgents } from '../db/messaging-groups.js';
import { canAccessAgentGroup } from '../modules/permissions/access.js';
import { log } from '../log.js';
import { parseProgressSnapshot, UUID, type TaskState } from './model.js';
import { getProgressCard, listProgressCards, saveProgressCard, snapshotOf, type ProgressCardRow } from './store.js';

const STATE_LABELS = {
  running: '実行中',
  completed: '完了',
  failed: '失敗',
  cancelled: '中断',
  interrupted: '中断（実行停止）',
};
const TASK_LABELS: Record<TaskState, string> = {
  queued: '待機',
  running: '実行中',
  completed: '完了',
  partial: '一部完了',
  failed: '失敗',
  timed_out: '時間切れ',
  cancelled: 'キャンセル',
};
export function progressMessage(row: ProgressCardRow) {
  const state = parseProgressSnapshot(snapshotOf(row));
  const ended = state.state !== 'running';
  const completed = state.tasks.filter((t) => t.state === 'completed').length;
  const issues = state.tasks.some((t) => ['partial', 'failed', 'timed_out', 'cancelled'].includes(t.state));
  let text = `### エージェントの進捗 — ${STATE_LABELS[state.state]}\n`;
  if (state.tasks.length) {
    text += `子タスク ${completed}/${state.tasks.length} 完了`;
    for (const status of ['partial', 'failed', 'timed_out', 'cancelled'] as const) {
      const count = state.tasks.filter((t) => t.state === status).length;
      if (count) text += ` / ${TASK_LABELS[status]} ${count}`;
    }
  } else text += ended ? '処理が終了しました。' : '処理を進めています。';
  if (row.expanded) {
    text +=
      '\n\n' +
      {
        preparing: '準備中',
        working: '親エージェントが処理中',
        delegating: '子タスクを実行中',
        synthesizing: '結果を統合中',
      }[state.phase];
    for (const batch of state.batches) {
      text += `\n\n**バッチ ${batch.ordinal} — ${TASK_LABELS[batch.state]}**`;
      for (const task of state.tasks.filter((t) => t.batchId === batch.id).sort((a, b) => a.ordinal - b.ordinal)) {
        text += `\n・${task.title}：${TASK_LABELS[task.state]}`;
        if (task.durationMs !== undefined) text += `（${Math.round(task.durationMs / 1000)}秒）`;
      }
    }
  }
  // 1 container + 1 text display + 1 row + 1 button = 4 components, even at maximum task count.
  const components: Record<string, unknown>[] = [{ type: 10, content: text }];
  if (ended)
    components.push({
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          custom_id: `ncp:1:${row.run_id}:${row.expanded ? 'c' : 'e'}`,
          label: row.expanded ? '閉じる' : '詳細を表示',
        },
      ],
    });
  return {
    flags: 32768,
    components: [
      {
        type: 17,
        accent_color:
          state.state === 'failed'
            ? 0xe74c3c
            : issues || state.state === 'cancelled' || state.state === 'interrupted'
              ? 0xf1c40f
              : ended
                ? 0x2ecc71
                : 0x3498db,
        components,
      },
    ],
    allowed_mentions: { parse: [], replied_user: false },
  };
}
interface Route {
  sessionId: string;
  agentGroupId: string;
  messagingGroupId: string;
  inReplyTo?: string | null;
}
export interface ProgressTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  deliver(platformId: string, threadId: string | null, content: Record<string, unknown>): Promise<string | undefined>;
  interaction(interaction: Record<string, unknown>): Promise<void>;
}
export interface DiscordProgressOptions {
  botToken: string;
  applicationId?: string;
  instance: string;
  fetch?: typeof fetch;
  now?: () => number;
  validateRoute?: (row: ProgressCardRow) => Promise<boolean>;
  isRunActive?: (row: ProgressCardRow) => Promise<boolean>;
  authorize?: (row: ProgressCardRow, userId: string) => Promise<boolean>;
}
class DiscordRequestError extends Error {
  constructor(
    readonly status: number,
    readonly retryMs = 0,
  ) {
    super(`Discord progress HTTP ${status}`);
  }
}
function discordAddress(encoded: string) {
  // Discord adapter encodeThreadId = discord:guild:channel[:thread].
  const [prefix, guild, channel, thread, ...extra] = encoded.split(':');
  if (
    prefix !== 'discord' ||
    !guild ||
    !/^\d{1,20}$/.test(channel ?? '') ||
    (thread && !/^\d{1,20}$/.test(thread)) ||
    extra.length ||
    (guild !== '@me' && !/^\d{1,20}$/.test(guild))
  )
    throw new Error('Invalid Discord progress address');
  return { channelId: thread || channel!, guildId: guild === '@me' ? null : guild };
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
export class DiscordProgress implements ProgressTransport {
  private chains = new Map<string, Promise<unknown>>();
  private timer?: ReturnType<typeof setInterval>;
  private sweeping?: Promise<void>;
  private debounce = new Map<string, ReturnType<typeof setTimeout>>();
  private lifecycle = new AbortController();
  private blockedUntil = 0;
  private lastEdit = new Map<string, number>();
  private request: typeof fetch;
  private now: () => number;
  constructor(private readonly options: DiscordProgressOptions) {
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }
  private stamp() {
    return new Date(this.now()).toISOString();
  }
  private serial<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const pending = (this.chains.get(runId) ?? Promise.resolve()).catch(() => {}).then(work);
    this.chains.set(runId, pending);
    void pending
      .finally(() => {
        if (this.chains.get(runId) === pending) this.chains.delete(runId);
      })
      .catch(() => {});
    return pending;
  }
  private async api(
    path: string,
    method: string,
    body?: unknown,
    bot = true,
    ack = false,
  ): Promise<Record<string, unknown>> {
    const response = await this.request(`https://discord.com/api/v10/${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(bot ? { Authorization: `Bot ${this.options.botToken}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(ack ? 1800 : 10000)]),
    });
    if (response.status === 204) return {};
    const data = object(await response.json().catch(() => ({})));
    if (!response.ok) {
      const seconds = Number(data.retry_after);
      const delay =
        response.status === 429
          ? Math.max(1000, Number.isFinite(seconds) && seconds >= 0 ? Math.min(604800000, seconds * 1000) : 1000)
          : 0;
      if (response.status === 429 && bot && data.global === true) this.blockedUntil = this.now() + delay;
      throw new DiscordRequestError(response.status, delay);
    }
    return data;
  }
  private schedule(runId: string, terminal = false) {
    if (this.lifecycle.signal.aborted) return;
    clearTimeout(this.debounce.get(runId));
    const delay = terminal ? 0 : Math.max(0, 1500 - (this.now() - (this.lastEdit.get(runId) ?? 0)));
    const timer = setTimeout(() => {
      this.debounce.delete(runId);
      void this.serial(runId, () => this.render(runId)).catch(() => log.warn('Progress render failed', { runId }));
    }, delay);
    this.debounce.set(runId, timer);
    timer.unref();
  }
  async start() {
    // A restart visibly interrupts the old run. Surviving containers may still
    // deliver a final answer, but a terminal card cannot reopen from late events.
    for (const row of await listProgressCards(this.options.instance)) {
      if (!row.snapshot || Date.parse(row.expires_at) <= this.now()) continue;
      if (row.delivery_state === 'sending') row.delivery_state = 'uncertain';
      const state = snapshotOf(row);
      if (state.state === 'running') {
        state.state = 'interrupted';
        for (const task of state.tasks)
          if (task.state === 'queued' || task.state === 'running') task.state = 'cancelled';
        for (const batch of state.batches)
          if (batch.state === 'queued' || batch.state === 'running') batch.state = 'cancelled';
        row.snapshot = JSON.stringify(state);
        row.expanded = 0;
        row.revision++;
        row.updated_at = this.stamp();
      }
      await saveProgressCard(row);
      if (row.revision > row.rendered_revision) this.schedule(row.run_id, true);
    }
    this.timer = setInterval(() => {
      if (this.sweeping) return;
      const pending = this.sweep().catch(() => log.warn('Progress sweep failed'));
      this.sweeping = pending;
      void pending.finally(() => {
        if (this.sweeping === pending) this.sweeping = undefined;
      });
    }, 5000);
    this.timer.unref();
  }
  async stop() {
    clearInterval(this.timer);
    for (const timer of this.debounce.values()) clearTimeout(timer);
    this.debounce.clear();
    this.lifecycle.abort();
    await this.sweeping;
    await Promise.allSettled([...this.chains.values()]);
  }
  async sweep() {
    const now = this.now();
    for (const row of await listProgressCards(this.options.instance)) {
      if (Date.parse(row.expires_at) <= now) {
        this.lastEdit.delete(row.run_id);
        if (row.snapshot) {
          row.snapshot = null;
          await this.serial(row.run_id, () => saveProgressCard(row));
        }
        continue;
      }
      if (row.snapshot && snapshotOf(row).state === 'running' && now - Date.parse(row.updated_at) >= 15000) {
        await this.serial(row.run_id, async () => {
          const latest = await getProgressCard(row.run_id);
          if (
            !latest?.snapshot ||
            snapshotOf(latest).state !== 'running' ||
            now - Date.parse(latest.updated_at) < 15000 ||
            (await this.runActive(latest))
          )
            return;
          const state = snapshotOf(latest);
          state.state = 'interrupted';
          for (const task of state.tasks)
            if (task.state === 'queued' || task.state === 'running') task.state = 'cancelled';
          for (const batch of state.batches)
            if (batch.state === 'queued' || batch.state === 'running') batch.state = 'cancelled';
          latest.snapshot = JSON.stringify(state);
          latest.expanded = 0;
          latest.revision++;
          latest.updated_at = this.stamp();
          await saveProgressCard(latest);
          this.schedule(latest.run_id, true);
        });
      }
      if ((row.delivery_state === 'new' || row.delivery_state === 'sent') && row.revision > row.rendered_revision)
        this.schedule(row.run_id, true);
    }
    await getDb().run(
      'DELETE FROM agent_progress_cards WHERE instance = ? AND expires_at < ?',
      this.options.instance,
      new Date(now - 30 * 86400000).toISOString(),
    );
  }
  private async runActive(row: ProgressCardRow): Promise<boolean> {
    if (this.options.isRunActive) return this.options.isRunActive(row);
    const session = await getSession(row.session_id);
    if (
      session &&
      session.agent_group_id === row.agent_group_id &&
      session.status === 'active' &&
      session.container_status !== 'stopped'
    )
      return true;
    // Final chat may be ahead of the terminal progress row in a slow delivery
    // queue. Do not mark that known normal finish interrupted before it drains.
    return (
      (await withExistingMailboxSession(row.agent_group_id, row.session_id, (mailbox) => {
        const delivered = mailbox.getDeliveredIds();
        return mailbox.getDueMessages(delivered).some((message) => {
          if (message.kind !== 'agent_progress' || delivered.has(message.id)) return false;
          try {
            const state = parseProgressSnapshot(JSON.parse(message.content));
            return state.runId === row.run_id && state.state !== 'running';
          } catch {
            return false;
          }
        });
      })) ?? false
    );
  }
  async deliver(platformId: string, threadId: string | null, content: Record<string, unknown>) {
    const state = parseProgressSnapshot(content.snapshot);
    const route = object(content.route) as unknown as Route;
    if (!route.sessionId || !route.agentGroupId || !route.messagingGroupId)
      throw new Error('Missing host progress route');
    const address = discordAddress(threadId ?? platformId);
    await this.serial(state.runId, async () => {
      await getDb().transaction(async () => {
        let row = await getProgressCard(state.runId);
        if (row) {
          if (
            row.instance !== this.options.instance ||
            row.session_id !== route.sessionId ||
            row.agent_group_id !== route.agentGroupId ||
            row.messaging_group_id !== route.messagingGroupId ||
            row.platform_id !== platformId ||
            row.thread_id !== threadId ||
            row.in_reply_to !== (route.inReplyTo ?? null)
          )
            throw new Error('Progress run route mismatch');
          if (!row.snapshot || snapshotOf(row).state !== 'running' || state.revision <= row.event_revision) return;
          row.snapshot = JSON.stringify(state);
          row.event_revision = state.revision;
          row.revision++;
          row.updated_at = this.stamp();
          if (state.state !== 'running') row.expanded = 0;
        } else {
          const now = this.stamp();
          row = {
            run_id: state.runId,
            instance: this.options.instance,
            session_id: route.sessionId,
            agent_group_id: route.agentGroupId,
            messaging_group_id: route.messagingGroupId,
            in_reply_to: route.inReplyTo ?? null,
            platform_id: platformId,
            thread_id: threadId,
            channel_id: address.channelId,
            guild_id: address.guildId,
            application_id: this.options.applicationId ?? null,
            bot_id: null,
            message_id: null,
            snapshot: JSON.stringify(state),
            event_revision: state.revision,
            revision: 1,
            rendered_revision: 0,
            expanded: state.state === 'running' ? 1 : 0,
            delivery_state: 'new',
            retry_at: null,
            created_at: now,
            updated_at: now,
            expires_at: new Date(this.now() + 7 * 86400000).toISOString(),
          };
        }
        await saveProgressCard(row);
      });
    });
    const row = await getProgressCard(state.runId);
    this.schedule(state.runId, state.state !== 'running');
    return row?.message_id ?? undefined;
  }
  private async render(runId: string) {
    const row = await getProgressCard(runId);
    if (
      !row ||
      !row.snapshot ||
      Date.parse(row.expires_at) <= this.now() ||
      row.revision <= row.rendered_revision ||
      this.lifecycle.signal.aborted
    )
      return;
    if (row.delivery_state === 'lost' || row.delivery_state === 'uncertain' || row.delivery_state === 'sending') return;
    if (this.blockedUntil > this.now() || (row.retry_at && Date.parse(row.retry_at) > this.now())) return;
    if (!(await this.liveRoute(row))) {
      row.delivery_state = 'lost';
      await saveProgressCard(row);
      return;
    }
    const creating = !row.message_id;
    if (creating) {
      row.delivery_state = 'sending';
      await saveProgressCard(row);
    }
    try {
      const data = await this.api(
        `channels/${row.channel_id}/messages${creating ? '' : `/${row.message_id}`}`,
        creating ? 'POST' : 'PATCH',
        progressMessage(row),
      );
      if (creating) {
        const author = object(data.author);
        if (
          typeof data.id !== 'string' ||
          !/^\d{1,20}$/.test(data.id) ||
          typeof author.id !== 'string' ||
          !/^\d{1,20}$/.test(author.id) ||
          author.bot !== true ||
          data.channel_id !== row.channel_id
        )
          throw new Error('Invalid Discord progress receipt');
        row.message_id = data.id;
        row.bot_id = author.id;
        row.application_id ??= author.id;
      }
      row.delivery_state = 'sent';
      row.rendered_revision = row.revision;
      row.retry_at = null;
      this.lastEdit.set(runId, this.now());
      await saveProgressCard(row);
    } catch (error) {
      const status = error instanceof DiscordRequestError ? error.status : 0;
      // Unknown POST outcome is never blindly retried: avoid a second card.
      row.delivery_state =
        status >= 400 && status < 500 && status !== 429
          ? 'lost'
          : creating && status !== 429
            ? 'uncertain'
            : creating
              ? 'new'
              : 'sent';
      row.retry_at = new Date(
        this.now() + (error instanceof DiscordRequestError ? error.retryMs || 5000 : 5000),
      ).toISOString();
      await saveProgressCard(row);
      log.warn('Discord progress delivery deferred', { runId, status, state: row.delivery_state });
    }
  }
  private async liveRoute(row: ProgressCardRow) {
    if (this.options.validateRoute) return this.options.validateRoute(row);
    const mg = await getMessagingGroup(row.messaging_group_id);
    return (
      !!mg &&
      !mg.detached_at &&
      !mg.denied_at &&
      mg.channel_type === 'discord' &&
      (mg.instance ?? 'discord') === row.instance &&
      mg.platform_id === row.platform_id &&
      (await getMessagingGroupAgents(mg.id)).some((w) => w.agent_group_id === row.agent_group_id)
    );
  }
  private async allowed(row: ProgressCardRow, userId: string) {
    if (!(await this.liveRoute(row))) return false;
    if (this.options.authorize) return this.options.authorize(row, userId);
    return (await canAccessAgentGroup(`discord:${userId}`, row.agent_group_id)).allowed;
  }
  async interaction(input: Record<string, unknown>) {
    const data = object(input.data),
      message = object(input.message),
      author = object(message.author);
    const customId = String(data.custom_id ?? '');
    const match = /^ncp:1:([^:]+):([ec])$/.exec(customId);
    const interactionId = String(input.id ?? ''),
      token = String(input.token ?? '');
    if (
      input.type !== 3 ||
      !/^\d{1,20}$/.test(interactionId) ||
      !/^\d{1,20}$/.test(String(input.application_id ?? '')) ||
      !token ||
      token.length > 2048
    )
      return;
    // ACK before DB lookup and before entering any per-run edit queue.
    try {
      await this.api(
        `interactions/${interactionId}/${encodeURIComponent(token)}/callback`,
        'POST',
        { type: 6 },
        false,
        true,
      );
    } catch {
      log.warn('Progress interaction acknowledgement failed');
      return;
    }
    const notice = async () => {
      try {
        await this.api(
          `webhooks/${String(input.application_id)}/${encodeURIComponent(token)}`,
          'POST',
          {
            content: 'この進捗カードは利用できません（期限切れ、権限不足、または古い表示）。',
            flags: 64,
            allowed_mentions: { parse: [] },
          },
          false,
        );
      } catch {
        log.warn('Progress interaction notice failed');
      }
    };
    if (!match || !UUID.test(match[1]!)) {
      await notice();
      return;
    }
    const user = object(object(input.member).user ?? input.user);
    let accepted = false;
    await this.serial(match[1]!, async () => {
      const row = await getProgressCard(match[1]!);
      if (
        !row ||
        row.instance !== this.options.instance ||
        !row.snapshot ||
        Date.parse(row.expires_at) <= this.now() ||
        row.delivery_state !== 'sent' ||
        row.message_id !== message.id ||
        row.channel_id !== input.channel_id ||
        row.guild_id !== (input.guild_id ?? null) ||
        row.application_id !== input.application_id ||
        row.bot_id !== author.id ||
        author.bot !== true ||
        !user.id ||
        user.bot === true ||
        !(await this.allowed(row, String(user.id))) ||
        snapshotOf(row).state === 'running'
      )
        return;
      row.expanded = match[2] === 'e' ? 1 : 0;
      row.revision++;
      row.updated_at = this.stamp();
      await saveProgressCard(row);
      accepted = true;
      // Bot token PATCH to original message; independent of interaction-token expiry.
      await this.render(row.run_id);
    });
    if (!accepted) await notice();
  }
}
