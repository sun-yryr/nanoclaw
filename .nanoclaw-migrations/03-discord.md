# Discord Channel Customizations

`SOURCE=5183f47ac903b36fa325d24900cfd5fb499149d1`

## Prerequisite

Run stock `/add-discord` on the clean upstream worktree first (channels branch).

## 1. Attachment download via CDN URL

**Intent:** Chat SDK attachments often have `url` but no `fetchData`.

**Copy as-is:**

- `src/attachment-download.ts`
- `src/attachment-download.test.ts`

**Wire:** In `src/channels/chat-sdk-bridge.ts`, use `downloadAttachmentBase64` when enriching inbound attachments (see SOURCE).

## 2. Discord URL / raw posting

**Intent:** Chat SDK markdown path turns bare URLs into `[url](url)`, which Discord renders poorly. Post as raw and unwrap identical-label links (named links stay).

**Copy as-is:**

- `src/channels/discord-links.ts`
- `src/channels/discord-links.test.ts`

**After stock `discord.ts` is installed**, set factory options (SOURCE):

```typescript
return createChatSdkBridge({
  adapter: discordAdapter,
  // ...existing options...
  postAsRaw: true,
  transformOutboundText: unwrapIdenticalDiscordLinks,
});
```

**Bridge support** (if upstream lacks these options, port from SOURCE `chat-sdk-bridge.ts`):

- Config flags: `postAsRaw`, `transformOutboundText`
- `toTextMessage()` that emits `{ raw }` when `postAsRaw`
- Apply `transformOutboundText` on outbound text paths
- Composite-ID guard from `02-core-policy.md`

## 3. Container skill

Copy from SOURCE:

- `container/skills/discord-formatting/SKILL.md`

(Teaches agents Discord link rules + tablesnap for tables — see `08-tablesnap.md`.)

## Verification

- `src/channels/discord-links.test.ts` passes.
- Outbound Discord messages show bare URLs, not `[https://…](https://…)`.