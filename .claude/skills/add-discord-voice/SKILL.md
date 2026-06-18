---
name: add-discord-voice
description: Add Discord voice-channel participation with OpenAI STT/TTS and selective spoken replies.
---

# Discord Voice

This repository includes a Discord voice companion on top of `/add-discord`. The bot can
join a voice channel, transcribe speech with OpenAI, route selected utterances through
the normal NanoClaw session pipeline, and speak the agent's reply back into the same
voice channel.

The voice loop is intentionally selective: explicit requests wake the agent, optional AI
judging can decide when a reply would be useful, and a low probability fallback keeps the
assistant from answering every human utterance.

## Implementation

The implementation is checked into the main source tree:

- `src/modules/discord-voice/index.ts` — Discord voice connection, capture, routing, TTS playback.
- `src/modules/discord-voice/openai.ts` — OpenAI STT/TTS and response-judge API calls.
- `src/modules/discord-voice/decision.ts` — explicit-request, AI-judge, and probability response gate.
- `src/modules/discord-voice/decision.test.ts` — response-gate tests.
- `src/discord-voice-wiring.test.ts` — startup wiring guard.

`src/index.ts` starts the module after the delivery adapter is installed. The module no-ops
unless `DISCORD_VOICE_ENABLED=true`.

## Prerequisites

1. Apply `/add-discord` first. This skill reuses `DISCORD_BOT_TOKEN`.
2. Install `ffmpeg` on the host. The voice module uses it indirectly through
   `@discordjs/voice`/`prism-media` to play generated WAV audio.
3. In the Discord Developer Portal, enable these privileged gateway intents:
   - Message Content Intent
4. Invite/update the bot with these permissions:
   - View Channels
   - Send Messages
   - Read Message History
   - Connect
   - Speak
   - Use Voice Activity

## Validate

```bash
pnpm run build
pnpm exec vitest run src/modules/discord-voice/decision.test.ts src/discord-voice-wiring.test.ts
```

The build guards the Discord voice dependencies and typed core imports. The wiring test
goes red if the startup block is removed or moved away from the delivery adapter setup.

## Configure

Add the required values to `.env`:

```bash
DISCORD_VOICE_ENABLED=true
OPENAI_API_KEY=your-openai-api-key
```

Optional tuning:

```bash
# Text command used in Discord. Examples: "!nc voice join", "!nc voice leave"
DISCORD_VOICE_COMMAND_PREFIX="!nc voice"

# Probability fallback used when there is no explicit request and AI judging is disabled
# or unavailable. Range: 0.0 to 1.0. Default: 0.15.
DISCORD_VOICE_RESPONSE_PROBABILITY=0.15

# Ask OpenAI whether the assistant should reply to a non-explicit utterance.
# Default: false.
DISCORD_VOICE_AI_JUDGE=true
DISCORD_VOICE_JUDGE_MODEL=gpt-4o-mini

# Route declined transcripts into the text session as non-mentions.
# Keep this false if the text-channel wiring uses engage_mode=pattern with ".".
DISCORD_VOICE_ROUTE_UNANSWERED=false

# OpenAI audio models.
DISCORD_VOICE_STT_MODEL=gpt-4o-mini-transcribe
DISCORD_VOICE_TTS_MODEL=gpt-4o-mini-tts
DISCORD_VOICE_TTS_VOICE=alloy
```

Restart the host after editing `.env`:

```bash
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)              # Linux
# launchctl kickstart -k gui/$(id -u)/$(launchd_label) # macOS
```

## Use

1. Join a Discord voice channel.
2. In the related text channel, send:

   ```text
   !nc voice join
   ```

3. Talk naturally. The bot transcribes completed speech segments, but only wakes the agent
   when one of these is true:
   - the utterance explicitly asks the bot/AI/NanoClaw to respond;
   - `DISCORD_VOICE_AI_JUDGE=true` and OpenAI judges a reply useful;
   - the probability fallback triggers.
     Declined transcripts are dropped by default. Set `DISCORD_VOICE_ROUTE_UNANSWERED=true`
     only when the linked text channel's wiring will not engage on every plain message.
4. To disconnect:

   ```text
   !nc voice leave
   ```

## Troubleshooting

### The bot joins but never transcribes

- Confirm the bot joined undeafened. The implementation uses `selfDeaf: false`.
- Check host logs for `[discord-voice]` warnings.
- Verify `opusscript` installed successfully and `ffmpeg` is on the host PATH.

### The bot transcribes but the agent does not answer

- Confirm the text channel used for `!nc voice join` is wired to an agent group.
- Try an explicit request such as "NanoClaw, what do you think?"
- Raise `DISCORD_VOICE_RESPONSE_PROBABILITY` temporarily for testing.

### The bot answers in text but does not speak

- The voice module only speaks bot messages that arrive shortly after a voice utterance it
  decided to answer.
- Confirm the bot has `Speak` permission in the voice channel.
- Check that OpenAI TTS settings and `OPENAI_API_KEY` are valid.
