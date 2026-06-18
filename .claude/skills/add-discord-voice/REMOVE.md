# Remove Discord Voice

Reverse every change made by `/add-discord-voice`.

## 1. Stop and disable

Remove or unset these values from `.env`:

```bash
DISCORD_VOICE_ENABLED
DISCORD_VOICE_COMMAND_PREFIX
DISCORD_VOICE_RESPONSE_PROBABILITY
DISCORD_VOICE_AI_JUDGE
DISCORD_VOICE_ROUTE_UNANSWERED
DISCORD_VOICE_SILENCE_MS
DISCORD_VOICE_MIN_AUDIO_MS
DISCORD_VOICE_PENDING_REPLY_TTL_MS
DISCORD_VOICE_OPENAI_BASE_URL
DISCORD_VOICE_STT_MODEL
DISCORD_VOICE_TTS_MODEL
DISCORD_VOICE_TTS_VOICE
DISCORD_VOICE_JUDGE_MODEL
OPENAI_API_KEY
```

Only remove `OPENAI_API_KEY` if no other local customization uses it.

## 2. Remove source files

```bash
rm -rf src/modules/discord-voice
rm -f src/discord-voice-wiring.test.ts
```

## 3. Remove the startup wiring

In `src/index.ts`, delete the two-line block added after `setDeliveryAdapter(createChannelDeliveryAdapter())`:

```ts
const { startDiscordVoice } = await import('./modules/discord-voice/index.js');
await startDiscordVoice();
```

## 4. Remove dependencies

```bash
pnpm uninstall discord.js @discordjs/voice prism-media opusscript
```

If another installed skill uses any of these packages, leave that package installed.

## 5. Validate

```bash
pnpm run build
pnpm test
```
