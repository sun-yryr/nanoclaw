#!/usr/bin/env bun
import { cpSync, existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const skill = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(skill, '../../..');
async function ncl(resource: string, verb: string, args: any) {
  const p = Bun.spawn([resolve(root, 'bin/ncl'), resource, ...verb.split(' '), '--stdin-json', '--json'], {
    stdin: new Blob([JSON.stringify(args)]),
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: root,
  });
  const [raw, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  let f: any;
  try {
    f = JSON.parse(raw);
  } catch {
    throw new Error(`ncl ${resource} ${verb} failed (${code})`);
  }
  if (!f.ok) throw new Error(f.error?.message ?? 'ncl failed');
  return f.data;
}
function args() {
  const argv = process.argv.slice(2);
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || !argv[i + 1])
      throw new Error('Use --group ID --account EMAIL --calendars JSON --destination NAME --timezone IANA');
    result[argv[i].slice(2)] = argv[i + 1];
  }
  return result;
}
export async function install() {
  const a = args();
  if (!a.group) throw new Error('--group required');
  const group = await ncl('groups', 'get', { id: a.group });
  if (!/^[a-zA-Z0-9_-]+$/.test(group.folder)) throw new Error('Invalid group folder');
  const folder = resolve(root, 'groups', group.folder);
  const runtime = resolve(root, 'container/skills/secretary');
  if (a.remove === 'true') {
    if (!existsSync(resolve(folder, 'secretary/ledger.db'))) return { removed: true };
    const { Ledger } = await import(resolve(runtime, 'ledger.ts'));
    const ledger = new Ledger(resolve(folder, 'secretary/ledger.db'));
    try {
      ledger.set('disabled', true);
      const task = ledger.get('hourly.task');
      const rows = await ncl('tasks', 'list', { group: a.group });
      const owned = new Set([
        task,
        ...(ledger.db.query('SELECT task_id FROM reminders WHERE task_id IS NOT NULL').all() as any[]).map(
          (r) => r.task_id,
        ),
      ]);
      for (const row of rows)
        if (owned.has(row.series_id)) await ncl('tasks', 'cancel', { group: a.group, id: row.series_id });
      ledger.set('disabled', true);
    } finally {
      ledger.close();
    }
    const note = resolve(folder, 'memory/ops/secretary.md');
    if (existsSync(note)) rmSync(note);
    const index = resolve(folder, 'memory/index.md');
    if (existsSync(index))
      writeFileSync(
        index,
        readFileSync(index, 'utf8')
          .split('\n')
          .filter((s) => !s.includes('<!-- secretary-index -->'))
          .join('\n'),
      );
    return { removed: true, recordsRetained: true, sharedRuntimeRetained: true };
  }
  const config = await ncl('groups', 'config get', { id: a.group });
  if (config.cli_scope === 'disabled') throw new Error('Secretary requires group ncl access');
  if (config.timezone && config.timezone !== a.timezone) throw new Error('Use the group timezone');
  const destinations = await ncl('destinations', 'list', { group: a.group });
  if (!destinations.some((d: any) => d.local_name === a.destination && d.target_type === 'channel'))
    throw new Error('Named channel destination required');
  // Default SQLite mailbox is the receipt adapter currently supported by this skill.
  const compose = readFileSync(resolve(root, 'container/agent-runner/src/mailbox/compose.ts'), 'utf8');
  if (!compose.includes('new SqliteAgentMailbox()'))
    throw new Error('Secretary receipt adapter requires the default SQLite mailbox');
  cpSync(resolve(skill, 'payload/secretary'), runtime, { recursive: true });
  cpSync(resolve(skill, 'payload/secretary.test.ts'), resolve(root, 'container/agent-runner/src/secretary.test.ts'));
  const { Ledger } = await import(resolve(runtime, 'ledger.ts'));
  const { request } = await import(resolve(runtime, 'google.ts'));
  const { installTask } = await import(resolve(runtime, 'runtime.ts'));
  const ledger = new Ledger(resolve(folder, 'secretary/ledger.db'));
  try {
    const calendars = JSON.parse(a.calendars ?? 'null');
    const settings = { account: a.account, calendars, destination: a.destination, timezone: a.timezone };
    // Read-only credentialed preflight; never enable an unverified account.
    const profile = await request('https://gmail.googleapis.com/gmail/v1/users/me/profile');
    if (profile.emailAddress !== a.account) throw new Error('Gateway Gmail account does not match --account');
    const list = await request('https://www.googleapis.com/calendar/v3/users/me/calendarList');
    for (const calendar of calendars ?? [])
      if (!list.items?.some((c: any) => c.id === calendar || (calendar === 'primary' && c.primary)))
        throw new Error(`Calendar not accessible: ${calendar}`);
    ledger.configure(settings);
    ledger.set('disabled', false);
    if (config.skills !== 'all' && !config.skills.includes('secretary')) {
      await ncl('groups', 'config update', { id: a.group, skills: JSON.stringify([...config.skills, 'secretary']) });
    }
    const task = await installTask(ledger, (verb: string, data: any) =>
      ncl('tasks', verb, { ...data, group: a.group }),
    );
    const note = resolve(folder, 'memory/ops/secretary.md');
    mkdirSync(dirname(note), { recursive: true });
    writeFileSync(
      note,
      `# Secretary\n\nThe secretary skill manages Gmail, Calendar, deadlines, local reply drafts and improvement proposals.\n\n- Ledger: secretary/ledger.db (use the skill helper, never raw SQL).\n- Hourly series: ${task.id}\n- Destination: ${a.destination}\n- Timezone: ${a.timezone}\n- Reviews: 09:00, 12:00, 15:00, 18:00; urgent notices have no quiet hours.\n\nLoad the secretary skill for conversation deadline changes and proposal handoffs. Inspect existing tasks before adding another digest.\n`,
    );
    const index = resolve(folder, 'memory/index.md');
    if (existsSync(index) && !readFileSync(index, 'utf8').includes('<!-- secretary-index -->'))
      writeFileSync(
        index,
        readFileSync(index, 'utf8') +
          '\n- [Secretary](ops/secretary.md) — deadlines, Gmail/Calendar monitoring, local drafts and proposals. <!-- secretary-index -->\n',
      );
    return {
      group: group.name,
      ...task,
      account: a.account,
      calendars,
      destination: a.destination,
      timezone: a.timezone,
    };
  } finally {
    ledger.close();
  }
}
if (import.meta.main)
  install()
    .then((r) => console.log(JSON.stringify(r)))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
