# Discord Voice (KEEP)

`SOURCE=5183f47ac903b36fa325d24900cfd5fb499149d1`

**Intent:** Join a Discord voice channel, STT with OpenAI, selectively `routeInbound` into the normal session pipeline, TTS the agent’s text reply back into VC. Same agent group / Cline path as text.

## Copy as-is from SOURCE

- `src/modules/discord-voice/` (entire directory)
- `src/discord-voice-wiring.test.ts`
- `.claude/skills/add-discord-voice/` (SKILL.md + REMOVE.md)

## Surgical hooks

### `src/index.ts`

After delivery adapter is installed (SOURCE):

```typescript
const { startDiscordVoice } = await import('./modules/discord-voice/index.js');
await startDiscordVoice();
```

Module no-ops unless `DISCORD_VOICE_ENABLED=true`.

### `src/command-gate.ts` (+ test)

Consume `!nc voice …` (prefix from `DISCORD_VOICE_COMMAND_PREFIX`, default `!nc voice`) so those commands never reach the agent container. Port the SOURCE filter logic into whatever command-gate shape upstream has.

### `package.json` deps (host)

Pin as SOURCE (or compatible):

- `@discordjs/voice@0.19.2`
- `opusscript@0.1.1`
- `prism-media@1.3.5`

(Requires Discord channel + `discord.js` already installed.)

## Env (do not commit secrets)

| Variable | Role |
|----------|------|
| `DISCORD_VOICE_ENABLED=true` | Activate |
| `DISCORD_BOT_TOKEN` | Shared with text Discord |
| `OPENAI_API_KEY` | STT / TTS / optional judge |
| `DISCORD_VOICE_*` | Join defaults, route-unanswered, command prefix, etc. (see skill) |

## Flow reminder

VC Opus → STT → `decideVoiceResponse` → `routeInbound` → router → inbound.db → Cline → outbound text → TTS → VC.

## Verification

- `src/discord-voice-wiring.test.ts` and `src/modules/discord-voice/*.test.ts` pass.
- With `DISCORD_VOICE_ENABLED` unset/false, host starts without joining VC.