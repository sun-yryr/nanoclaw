import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const stamp = () => new Date().toISOString();
export interface Config {
  account: string;
  calendars: string[];
  destination: string;
  timezone: string;
}
export interface Item {
  id: string;
  title: string;
  source: string;
  evidence: string;
  state: 'candidate' | 'todo' | 'doing' | 'waiting' | 'done' | 'cancelled';
  due: string | null;
  dateOnly: boolean;
  timezone: string;
  revision: number;
}
export function localParts(date: Date, timezone: string) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
}
export function localNine(day: string, timezone: string): string {
  const target = Date.parse(`${day}T09:00:00Z`);
  let value = target;
  for (let i = 0; i < 4; i++) {
    const p = localParts(new Date(value), timezone);
    const rendered = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    const delta = target - rendered;
    value += delta;
    if (!delta) return new Date(value).toISOString();
  }
  throw new Error('Cannot resolve local reminder time');
}
export function reminderTimes(item: Item, now: string): string[] {
  if (!item.due || ['candidate', 'done', 'cancelled'].includes(item.state)) return [];
  if (item.dateOnly) {
    const p = localParts(new Date(now), item.timezone);
    if (item.due < `${p.year}-${p.month}-${p.day}`) return [];
  } else if (Date.parse(item.due) < Date.parse(now)) return [];
  let times: string[];
  if (item.dateOnly) {
    const previous = new Date(Date.parse(`${item.due}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
    times = [localNine(previous, item.timezone), localNine(item.due, item.timezone)];
  } else {
    const due = Date.parse(item.due);
    times = [new Date(due - 86400000).toISOString(), new Date(due - 7200000).toISOString()];
  }
  // Collapse already elapsed reminders to one current reminder.
  return [...(times.some((t) => t <= now) ? [now] : []), ...times.filter((t) => t > now)];
}
export class Ledger {
  db: Database;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,version TEXT NOT NULL,payload TEXT NOT NULL,
        pending INTEGER NOT NULL,bootstrap INTEGER NOT NULL,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY,item_id TEXT,body TEXT,at TEXT);
      CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY,item_id TEXT,revision INTEGER,at TEXT,
        task_id TEXT,status TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,body TEXT NOT NULL,status TEXT NOT NULL,
        message_id TEXT,session_id TEXT,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leases(key TEXT PRIMARY KEY,owner TEXT NOT NULL,until_ms INTEGER NOT NULL);`);
  }
  close() {
    this.db.close();
  }
  get<T>(key: string): T | undefined {
    const row = this.db.query('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | null;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  set(key: string, value: unknown) {
    this.db
      .query('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  }
  lease(key: string, owner: string, ms = 120000) {
    return this.db
      .transaction(() => {
        const row = this.db.query('SELECT until_ms FROM leases WHERE key=?').get(key) as { until_ms: number } | null;
        if (row && row.until_ms > Date.now()) return false;
        this.db.query('INSERT OR REPLACE INTO leases VALUES (?,?,?)').run(key, owner, Date.now() + ms);
        return true;
      })
      .immediate();
  }
  release(key: string, owner: string) {
    this.db.query('DELETE FROM leases WHERE key=? AND owner=?').run(key, owner);
  }
  config(): Config {
    const c = this.get<Config>('config');
    if (!c) throw new Error('Run configure first');
    return c;
  }
  configure(c: Config) {
    if (
      !c ||
      typeof c.account !== 'string' ||
      !c.account ||
      c.account === 'me' ||
      typeof c.timezone !== 'string' ||
      !c.timezone ||
      typeof c.destination !== 'string' ||
      !c.destination ||
      !Array.isArray(c.calendars) ||
      !c.calendars.length ||
      c.calendars.some((x) => typeof x !== 'string' || !x)
    )
      throw new Error('account, calendars, destination required');
    localParts(new Date(), c.timezone);
    const old = this.get<Config>('config');
    if (old && (old.account !== c.account || JSON.stringify(old.calendars) !== JSON.stringify(c.calendars)))
      throw new Error('Use a new ledger for a different account/calendar selection');
    this.set('config', c);
  }
  ingest(id: string, version: string, payload: unknown, bootstrap = false) {
    this.db
      .query(
        `INSERT INTO sources VALUES (?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET
      version=excluded.version,payload=excluded.payload,pending=1,bootstrap=excluded.bootstrap,updated=excluded.updated
      WHERE sources.version<>excluded.version`,
      )
      .run(id, version, JSON.stringify(payload), bootstrap ? 1 : 0, stamp());
  }
  inbox() {
    return this.db.query('SELECT * FROM sources WHERE pending=1 ORDER BY bootstrap ASC,updated DESC LIMIT 10').all();
  }
  ack(id: string, version: string) {
    this.db.query('UPDATE sources SET pending=0 WHERE id=? AND version=?').run(id, version);
  }
  item(id: string): Item | undefined {
    const row = this.db.query('SELECT body FROM items WHERE id=?').get(id) as { body: string } | null;
    return row ? JSON.parse(row.body) : undefined;
  }
  items(): Item[] {
    return (this.db.query('SELECT body FROM items').all() as { body: string }[]).map((r) => JSON.parse(r.body));
  }
  putItem(input: Omit<Item, 'revision'>, expected: number, now = stamp()) {
    if (
      !input ||
      typeof input.id !== 'string' ||
      !/^[a-zA-Z0-9:_-]{1,160}$/.test(input.id) ||
      typeof input.title !== 'string' ||
      !input.title.trim() ||
      input.title.length > 2000 ||
      typeof input.source !== 'string' ||
      !input.source ||
      typeof input.evidence !== 'string' ||
      !input.evidence ||
      input.evidence.length > 16000 ||
      typeof input.dateOnly !== 'boolean' ||
      !Number.isInteger(expected) ||
      expected < 0 ||
      !['candidate', 'todo', 'doing', 'waiting', 'done', 'cancelled'].includes(input.state)
    )
      throw new Error('Invalid item');
    localParts(new Date(), input.timezone);
    if (input.due !== null && typeof input.due !== 'string') throw new Error('due must be null or date/timestamp');
    if (input.due === '') throw new Error('Use null for no deadline');
    if (input.due) {
      if (input.dateOnly) {
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(input.due) ||
          new Date(`${input.due}T00:00:00Z`).toISOString().slice(0, 10) !== input.due
        )
          throw new Error('Invalid date');
      } else {
        if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input.due) || !Number.isFinite(Date.parse(input.due)))
          throw new Error('Timestamp requires offset');
        input = { ...input, due: new Date(input.due).toISOString() };
      }
    }
    return this.db
      .transaction(() => {
        if (!Number.isFinite(Date.parse(now))) throw new Error('Invalid now');
        const old = this.item(input.id);
        if ((old?.revision ?? 0) !== expected) throw new Error('Revision conflict: reload item');
        const item = { ...input, revision: expected + 1 };
        this.db.query('INSERT OR REPLACE INTO items VALUES (?,?,?)').run(item.id, item.revision, JSON.stringify(item));
        this.db.query('INSERT INTO history(item_id,body,at) VALUES (?,?,?)').run(item.id, JSON.stringify(item), now);
        // A title/state update must not recreate already-sent deadline reminders.
        const changed =
          !old ||
          old.due !== item.due ||
          old.dateOnly !== item.dateOnly ||
          old.timezone !== item.timezone ||
          ['candidate', 'done', 'cancelled'].includes(old.state) !==
            ['candidate', 'done', 'cancelled'].includes(item.state);
        if (changed) {
          this.db.query("UPDATE reminders SET status='obsolete' WHERE item_id=? AND status<>'dispatched'").run(item.id);
          for (const at of reminderTimes(item, now)) {
            this.db
              .query('INSERT INTO reminders(id,item_id,revision,at) VALUES (?,?,?,?)')
              .run(`${item.id}:${item.revision}:${at}`, item.id, item.revision, at);
          }
        } else {
          this.db
            .query("UPDATE reminders SET revision=? WHERE item_id=? AND status='pending'")
            .run(item.revision, item.id);
        }
        return item;
      })
      .immediate();
  }
  reminder(id: string) {
    const r = this.db.query("SELECT * FROM reminders WHERE id=? AND status='pending'").get(id) as {
      id: string;
      item_id: string;
      revision: number;
      at: string;
      task_id: string | null;
    } | null;
    const item = r && this.item(r.item_id);
    return r && item && item.revision === r.revision && !['done', 'cancelled', 'candidate'].includes(item.state)
      ? { ...r, item }
      : null;
  }
  reviewSlot(now = new Date()) {
    const p = localParts(now, this.config().timezone);
    return ['09', '12', '15', '18'].includes(p.hour) ? `${p.year}-${p.month}-${p.day}T${p.hour}` : null;
  }
  status() {
    return {
      config: this.config(),
      health: this.get('health'),
      review: this.get('review'),
      pending: this.db.query('SELECT count(*) AS count FROM sources WHERE pending=1').get(),
      reminders: this.db.query("SELECT * FROM reminders WHERE status='pending' ORDER BY at LIMIT 20").all(),
      notifications: this.db.query('SELECT * FROM notifications ORDER BY updated DESC LIMIT 20').all(),
    };
  }
}
