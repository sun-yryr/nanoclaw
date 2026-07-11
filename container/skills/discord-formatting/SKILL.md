---
name: discord-formatting
description: Format messages for Discord using Discord markdown. Use when responding to Discord channels or destinations (inbound message has from="discord-..." or you are sending to a Discord destination).
---

# Discord Message Formatting

When responding on Discord, use Discord's markdown subset. Discord is closer to standard Markdown than Slack, but link syntax has quirks — especially when the link text is the same as the URL.

## How to detect Discord context

You're in a Discord conversation when any of these are true:

- An inbound `<message>` carries `from="discord-..."` (or another destination name wired to Discord — check your runtime `## Sending messages` section)
- You are sending to a destination that routes to Discord (`to="discord-..."` in `<message>` blocks or `send_message`)
- The inbound metadata or destination map shows `channel_type: discord`

## Formatting reference

### Text styles

| Style | Syntax | Example |
|-------|--------|---------|
| Bold | `**text**` or `__text__` | **bold text** |
| Italic | `*text*` or `_text_` | *italic text* |
| Bold + italic | `***text***` | ***both*** |
| Strikethrough | `~~text~~` | ~~strikethrough~~ |
| Underline | `__text__` (when not used for bold) | underlined |
| Code (inline) | `` `code` `` | `inline code` |
| Code block | ` ```lang\ncode\n``` ` | fenced block |
| Spoiler | `\|\|hidden\|\|` | hidden until clicked |
| Quote | `> text` | block quote |

### Links — the important part

Discord supports named markdown links and bare auto-linked URLs. **Do not** write `[url](url)` where the display text equals the URL — Discord often fails to render those as clickable links.

**Allowed (pick one):**

```
[View the build](https://example.com/builds/123)   # Named link — preferred when you have a label
https://example.com/builds/123                      # Bare URL — auto-linked
```

**Forbidden:**

```
[https://example.com](https://example.com)          # Same text and URL — often breaks
[https://example.com/foo](https://example.com/foo)  # Same pattern with a path
```

When you only have a URL and no good label, paste the bare URL. When you have a label, use `[label](url)` with a **short human-readable title**, not the raw URL repeated.

### Lists

Discord supports bullet and numbered lists:

```
- First item
- Second item

1. First step
2. Second step
```

### Headings

Discord supports `#`, `##`, `###` headings, but in short chat replies prefer bold (`**Section**`) over heavy heading markup.

### Mentions

```
<@123456789012345678>        # User by snowflake ID
<@!123456789012345678>       # User mention (nickname)
<#123456789012345678>        # Channel by ID
<@&123456789012345678>       # Role by ID
```

Use display names in prose when you don't have the snowflake ID. Don't paste Slack (`<url|text>`) or WhatsApp (`@digits`) mention syntax.

## What NOT to use

- **NO** `[url](url)` links where the bracket text is the same as the URL (use bare URL or `[title](url)` instead)
- **NO** Slack mrkdwn (`<https://example.com|text>`, `*bold*` for bold in Slack sense)
- **NO** tables (Discord does not render markdown tables — use bullets or a code block)
- **NO** `---` horizontal rules (not supported)

## Example message

```
**Daily mail summary**

昨日は12通。返信が必要なのは2件、プロモが多め。

- **Acme Corp:** 見積もりの確認待ち → Tasks に追加済み
- **Bank notice:** 明細のお知らせ（対応不要）

https://mail.google.com/mail/u/0/#inbox
```

## Quick rules

1. Links: `[short title](url)` **or** bare `url` — never `[url](url)`
2. Bold: `**text**` (not Slack's `*text*`)
3. Prefer bullets for lists; headings optional in short replies
4. Check `from="discord-..."` on inbound messages to know you're on Discord
5. When in doubt about a link, use the bare URL
