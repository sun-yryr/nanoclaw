import type { Ledger } from './ledger.ts';
export interface ReactionFeedback {
  message_id: string;
  user_id: string;
  emoji: string;
  meaning: string;
  active: number;
  updated_at: string;
  body: string;
}
export async function fetchFeedback() {
  const child = Bun.spawn(['ncl', 'groups', 'feedback', '--json'], { stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const [raw, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const frame = JSON.parse(raw);
    if (code !== 0 || !frame.ok || !Array.isArray(frame.data?.feedback))
      throw new Error('Reaction feedback unavailable');
    return frame.data as { feedback: ReactionFeedback[]; truncated: boolean };
  } finally {
    clearTimeout(timer);
  }
}
export function notificationFeedback(ledger: Ledger, rows: ReactionFeedback[]) {
  const notifications = ledger.db.query('SELECT id,message_id,body FROM notifications').all() as {
    id: string;
    message_id: string;
    body: string;
  }[];
  return notifications.flatMap((n) => {
    const reactions = rows.filter((r) => r.message_id === n.message_id && r.active === 1);
    if (!reactions.length) return [];
    return [
      {
        ...n,
        seen: reactions.some((r) => r.meaning === 'seen'),
        acknowledged: reactions.some((r) => r.meaning === 'acknowledged'),
        seenBy: reactions.filter((r) => r.meaning === 'seen').map((r) => r.user_id),
        acknowledgedBy: reactions.filter((r) => r.meaning === 'acknowledged').map((r) => r.user_id),
        ratings: reactions.filter((r) => ['good_answer', 'bad_answer'].includes(r.meaning)),
        reactions,
      },
    ];
  });
}
