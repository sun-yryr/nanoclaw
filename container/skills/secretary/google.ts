import { Ledger, hash, stamp } from './ledger.ts';

export class ApiError extends Error {
  constructor(
    public status: number,
    public service: string,
  ) {
    super(`${service}: HTTP ${status}`);
  }
}
export type Request = (url: string) => Promise<any>;
// curl uses the session's gateway proxy and CA. No auth material is read locally.
export const request: Request = async (url) => {
  if (!process.env.HTTPS_PROXY && !process.env.https_proxy) throw new Error('Credential gateway proxy required');
  const target = new URL(url);
  if (
    target.protocol !== 'https:' ||
    !['gmail.googleapis.com', 'www.googleapis.com', 'calendar.googleapis.com'].includes(target.hostname)
  )
    throw new Error('Unsupported Google endpoint');
  const child = Bun.spawn(
    [
      'curl',
      '--silent',
      '--show-error',
      '--max-time',
      '8',
      '--max-filesize',
      '4194304',
      '--write-out',
      '\n%{http_code}',
      url,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [raw, , exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit) throw new Error(`${target.hostname}: network request failed (${exit})`);
  const split = raw.lastIndexOf('\n');
  const status = Number(raw.slice(split + 1));
  if (status < 200 || status >= 300) throw new ApiError(status, target.hostname);
  return JSON.parse(raw.slice(0, split));
};
function endpoint(base: string, params: Record<string, string | undefined>) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url.href;
}
function mailBody(part: any): string {
  const collect = (p: any, mime: string): string => {
    if (!p || p.filename) return '';
    if (p.mimeType === mime && p.body?.data)
      return Buffer.from(p.body.data, 'base64url').toString('utf8').slice(0, 16000);
    return (p.parts ?? [])
      .map((v: any) => collect(v, mime))
      .join('\n')
      .trim()
      .slice(0, 16000);
  };
  const plain = collect(part, 'text/plain');
  if (plain) return plain;
  return collect(part, 'text/html')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp);/g,
      (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[entity]!,
    )
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, code: string) => {
      const n = code.toLowerCase().startsWith('x') ? parseInt(code.slice(1), 16) : Number(code);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16000);
}
function mailPayload(m: any) {
  return {
    id: m.id,
    threadId: m.threadId,
    labels: (m.labelIds ?? []).filter((label: string) => !['UNREAD', 'STARRED', 'IMPORTANT'].includes(label)).sort(),
    internalDate: m.internalDate,
    headers: (m.payload?.headers ?? []).filter((h: any) =>
      ['from', 'to', 'cc', 'subject', 'date', 'in-reply-to'].includes(h.name.toLowerCase()),
    ),
    text: mailBody(m.payload) || m.snippet || '',
    link: `https://mail.google.com/mail/u/0/#all/${m.threadId}`,
  };
}
interface MailScan {
  mode: 'full' | 'history';
  start: string;
  page?: string;
  ids?: string[];
  next?: string;
  end?: string;
  loaded?: boolean;
  bootstrap: boolean;
  began?: string;
}
export async function syncMail(ledger: Ledger, get: Request, deadline: number) {
  const root = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(ledger.config().account)}`;
  let scan = ledger.get<MailScan>('mail.scan');
  if (!scan) {
    const cursor = ledger.get<string>('mail.cursor');
    const profile = cursor ? null : await get(`${root}/profile`);
    scan = {
      mode: cursor ? 'history' : 'full',
      start: cursor ?? profile.historyId,
      bootstrap: !ledger.get('mail.initialized'),
      began: stamp(),
    };
    ledger.set('mail.scan', scan);
  }
  while (Date.now() < deadline) {
    if (!scan.loaded) {
      let page: any;
      try {
        page = await get(
          scan.mode === 'full'
            ? endpoint(`${root}/messages`, {
                q: ledger.get('mail.initialized')
                  ? `after:${Math.floor(Date.parse(ledger.get<string>('mail.lastSuccess') ?? ledger.get<any>('health:gmail')?.lastSuccess ?? new Date(Date.now() - 7 * 86400000).toISOString()) / 1000) - 3600}`
                  : 'newer_than:7d',
                maxResults: '50',
                pageToken: scan.page,
              })
            : endpoint(`${root}/history`, { startHistoryId: scan.start, maxResults: '50', pageToken: scan.page }),
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404 && scan.mode === 'history') {
          ledger.set('mail.cursor', null);
          ledger.set('mail.scan', null);
          return syncMail(ledger, get, deadline);
        }
        throw error;
      }
      const ids: string[] =
        scan.mode === 'full'
          ? (page.messages ?? []).map((m: any) => m.id)
          : (page.history ?? []).flatMap((h: any) =>
              ['messagesAdded', 'messagesDeleted', 'labelsAdded', 'labelsRemoved'].flatMap((k) =>
                (h[k] ?? []).map((v: any) => v.message.id),
              ),
            );
      scan = {
        ...scan,
        ids: [...new Set<string>(ids)],
        next: page.nextPageToken,
        end: page.historyId ?? scan.start,
        loaded: true,
      };
      ledger.set('mail.scan', scan);
    }
    if (scan.ids?.length) {
      const ids: string[] = scan.ids.slice(0, 4);
      const messages = await Promise.all(
        ids.map(async (id) => {
          try {
            return {
              id,
              payload: mailPayload(
                await get(endpoint(`${root}/messages/${encodeURIComponent(id)}`, { format: 'full' })),
              ),
            };
          } catch (error) {
            if (error instanceof ApiError && error.status === 404) return { id, payload: { id, deleted: true } };
            throw error;
          }
        }),
      );
      ledger.db
        .transaction(() => {
          for (const m of messages)
            ledger.ingest(`gmail:${m.id}`, hash(JSON.stringify(m.payload)), m.payload, scan!.bootstrap);
          scan!.ids = scan!.ids!.slice(ids.length);
          ledger.set('mail.scan', scan);
        })
        .immediate();
      continue;
    }
    if (scan.next) {
      scan = { ...scan, page: scan.next, ids: [], loaded: false, next: undefined };
      ledger.set('mail.scan', scan);
    } else {
      ledger.db
        .transaction(() => {
          ledger.set('mail.cursor', scan!.end ?? scan!.start);
          ledger.set('mail.scan', null);
          ledger.set('mail.initialized', true);
          ledger.set('mail.lastSuccess', scan!.began ?? stamp());
        })
        .immediate();
      return true;
    }
  }
  return false;
}
interface CalendarScan {
  page?: string;
  cursor?: string;
  bootstrap: boolean;
}
function eventPayload(calendar: string, e: any) {
  return {
    calendar,
    id: e.id,
    status: e.status,
    title: e.summary,
    description: e.description?.slice(0, 16000),
    start: e.start,
    end: e.end,
    recurrence: e.recurrence,
    recurringEventId: e.recurringEventId,
    originalStartTime: e.originalStartTime,
    attendees: e.attendees?.map((a: any) => ({ email: a.email, self: a.self, responseStatus: a.responseStatus })),
    link: e.htmlLink,
    location: e.location,
    updated: e.updated,
  };
}
export async function syncCalendar(ledger: Ledger, calendar: string, get: Request, deadline: number) {
  const key = `calendar:${calendar}`;
  const root = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar)}/events`;
  let scan = ledger.get<CalendarScan>(`${key}.scan`) ?? {
    cursor: ledger.get<string>(`${key}.cursor`),
    bootstrap: !ledger.get(`${key}.initialized`),
  };
  while (Date.now() < deadline) {
    let page: any;
    try {
      page = await get(
        endpoint(root, {
          syncToken: scan.cursor,
          pageToken: scan.page,
          maxResults: '100',
          showDeleted: 'true',
          singleEvents: 'false',
        }),
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 410 && scan.cursor) {
        scan = { bootstrap: false };
        ledger.set(`${key}.scan`, scan);
        continue;
      }
      throw error;
    }
    const now = Date.now();
    const horizon = now + 30 * 86400000;
    ledger.db
      .transaction(() => {
        for (const e of page.items ?? []) {
          const id = `${key}:${e.id}`;
          const known = ledger.db.query('SELECT 1 FROM sources WHERE id=?').get(id);
          const start = Date.parse(e.start?.dateTime ?? e.start?.date ?? '');
          const end = Date.parse(e.end?.dateTime ?? e.end?.date ?? '');
          // Keep recurring masters for context; instances are projected separately below.
          if (known || e.recurrence || (start <= horizon && end >= now)) {
            const payload = eventPayload(calendar, e);
            ledger.ingest(id, hash(JSON.stringify(payload)), payload, scan.bootstrap);
          }
        }
        if (page.nextPageToken) {
          scan = { ...scan, page: page.nextPageToken };
          ledger.set(`${key}.scan`, scan);
        } else {
          if (!page.nextSyncToken) throw new Error('Calendar sync token missing');
          ledger.set(`${key}.cursor`, page.nextSyncToken);
          ledger.set(`${key}.scan`, null);
          ledger.set(`${key}.initialized`, true);
        }
      })
      .immediate();
    if (!page.nextPageToken) return true;
  }
  return false;
}
// Rolling projection makes recurring instances and newly approaching events visible.
export async function upcoming(ledger: Ledger, calendar: string, get: Request, deadline: number) {
  const key = `upcoming:${calendar}`;
  let scan = ledger.get<{ start: string; end: string; page?: string; bootstrap: boolean }>(key);
  if (!scan)
    scan = {
      start: stamp(),
      end: new Date(Date.now() + 30 * 86400000).toISOString(),
      bootstrap: !ledger.get(`${key}.initialized`),
    };
  while (Date.now() < deadline) {
    const page = await get(
      endpoint(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar)}/events`, {
        timeMin: scan.start,
        timeMax: scan.end,
        singleEvents: 'true',
        maxResults: '100',
        pageToken: scan.page,
      }),
    );
    ledger.db
      .transaction(() => {
        for (const e of page.items ?? []) {
          const payload = eventPayload(calendar, e);
          ledger.ingest(`calendar:${calendar}:${e.id}`, hash(JSON.stringify(payload)), payload, scan!.bootstrap);
        }
        if (page.nextPageToken) {
          scan!.page = page.nextPageToken;
          ledger.set(key, scan);
        } else {
          ledger.set(key, null);
          ledger.set(`${key}.initialized`, true);
        }
      })
      .immediate();
    if (!page.nextPageToken) return true;
  }
  ledger.set(key, scan);
  return false;
}
export async function synchronize(ledger: Ledger, get: Request = request, budgetMs = 18000) {
  const owner = crypto.randomUUID();
  if (!ledger.lease('sync', owner)) return { busy: true };
  const deadline = Date.now() + budgetMs;
  const keys = ['gmail', ...ledger.config().calendars.flatMap((c) => [`calendar:${c}`, `upcoming:${c}`])];
  const start = ledger.get<number>('sync.rotation') ?? 0;
  ledger.set('sync.rotation', (start + 1) % keys.length);
  const failures: string[] = [];
  try {
    for (const key of [...keys.slice(start), ...keys.slice(0, start)]) {
      if (Date.now() >= deadline) break;
      const health = ledger.get<any>(`health:${key}`) ?? { failures: 0 };
      try {
        const complete =
          key === 'gmail'
            ? await syncMail(ledger, get, deadline)
            : key.startsWith('upcoming:')
              ? await upcoming(ledger, key.slice(9), get, deadline)
              : await syncCalendar(ledger, key.slice(9), get, deadline);
        ledger.set(`alert:${key}`, null);
        ledger.set(`health:${key}`, {
          ...health,
          lastAttempt: stamp(),
          lastSuccess: complete ? stamp() : health.lastSuccess,
          failures: 0,
          error: null,
          incomplete: !complete,
        });
      } catch (error) {
        const status = error instanceof ApiError ? error.status : null;
        if (!health.failures) ledger.set(`incident:${key}`, stamp());
        const next = {
          ...health,
          lastAttempt: stamp(),
          failures: health.failures + 1,
          error: error instanceof Error ? error.message : 'Sync failed',
          status,
        };
        ledger.set(`health:${key}`, next);
        failures.push(key);
        if (
          ([401, 403].includes(status!) || next.failures >= 3) &&
          ledger.get(`reported:${key}`) !== ledger.get(`incident:${key}`)
        )
          ledger.set(`alert:${key}`, { service: key, error: next.error });
      }
    }
    const health = Object.fromEntries(
      keys.map((k) => [k, ledger.get(`health:${k}`) ?? { lastSuccess: null, incomplete: true }]),
    );
    ledger.set('health', health);
    return { health, failures };
  } finally {
    ledger.release('sync', owner);
  }
}
