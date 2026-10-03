/**
 * Discord markdown link sanitizer.
 *
 * Discord auto-links http(s)/www URLs *before* it parses markdown links. When
 * the link text is itself a URL — `[https://example.com](https://example.com)` —
 * the inner auto-link wins and the markdown often fails to render as a
 * clickable named link. Bare URLs auto-link correctly, so the fix is to unwrap
 * those identical-label forms.
 *
 * Named links with a human-readable label (`[View the build](url)`) are left
 * alone. Code fences and inline code are skipped so examples stay literal.
 *
 * See container/skills/discord-formatting/SKILL.md.
 */

const CODE_SPLIT_RE = /(```[\s\S]*?```|`[^`\n]+`)/;

/** Markdown link: [label](url) or [label](<url>). */
const MD_LINK_RE = /\[([^\]]+)\]\(\s*(?:<([^>\n]+)>|((?:https?:\/\/|www\.)[^)\s]+))\s*\)/gi;

function stripAngleBrackets(s: string): string {
  const t = s.trim();
  return t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1).trim() : t;
}

function normalizeUrl(s: string): string {
  let u = stripAngleBrackets(s);
  if (u.endsWith('/') && !/^https?:\/\/$/i.test(u)) u = u.slice(0, -1);
  return u.toLowerCase();
}

function unwrapProse(text: string): string {
  return text.replace(MD_LINK_RE, (full, label: string, angleUrl?: string, bareUrl?: string) => {
    const href = (angleUrl ?? bareUrl ?? '').trim();
    if (!href) return full;
    if (normalizeUrl(label) !== normalizeUrl(href)) return full;
    return stripAngleBrackets(href);
  });
}

/**
 * Unwrap `[url](url)` (and equivalent `<url>` / trailing-slash variants) to a
 * bare URL so Discord auto-links them. Leaves distinct-label markdown links
 * and fenced/inline code unchanged.
 */
export function unwrapIdenticalDiscordLinks(text: string): string {
  return text
    .split(CODE_SPLIT_RE)
    .map((part, i) => (i % 2 === 1 ? part : unwrapProse(part)))
    .join('');
}
