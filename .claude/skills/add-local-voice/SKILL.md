---
name: add-local-voice
description: Add a Linux microphone channel activated by a custom Porcupine wake word, with OpenAI STT and TTS.
---

# Local Voice

Add a half-duplex local voice channel:

1. Porcupine detects a custom wake phrase on the Linux host.
2. The sidecar records until trailing silence and sends an in-memory WAV over a
   Unix socket.
3. The host uses OpenAI STT and routes the transcript through the normal
   messaging-group and session pipeline.
4. The agent reply is synthesized with OpenAI TTS and played through `aplay`.

Only post-wake audio leaves the machine. Audio and transcripts are not persisted.
TTS playback pauses wake detection to prevent the assistant from triggering itself.

## Implementation

- `src/channels/local-voice.ts` — channel adapter, bounded Unix-socket protocol,
  OpenAI STT/TTS, routing, and playback acknowledgement.
- `src/channels/local-voice-openai.ts` — timeout-aware STT and size-bounded TTS HTTP client.
- `services/local-voice/local_voice.py` — Porcupine detection, VAD recording,
  reconnect behavior, and in-memory playback.
- `services/local-voice/requirements.txt` — pinned Python runtime dependencies.
- `services/local-voice/install-systemd.sh` — isolated venv and systemd user unit.
- `scripts/init-local-voice.ts` — idempotent central-DB wiring through core helpers.
- `src/local-voice.test.ts` and `src/local-voice-registration.test.ts` — integration tests.
- `src/local-voice-openai.test.ts` — bounded TTS response regression test.

## Prerequisites

- Linux with a working microphone and speaker.
- Python 3.9+ with the `venv` module.
- `aplay` from `alsa-utils`.
- A working OpenAI audio configuration. The adapter uses the existing
  `OPENAI_API_KEY` and defaults used by Discord voice.
- A Picovoice account and AccessKey.

Never paste either credential into chat or command arguments.

## Create the wake-word model

In Picovoice Console:

1. Open Porcupine and create a custom wake word.
2. Choose English and enter `Hey NanoClaw`.
3. Choose the Linux platform matching this host.
4. Download the generated `.ppn` file.

The model is platform-specific. Do not substitute a Raspberry Pi or macOS model.

## Configure the Picovoice credential

Determine the slugged service name:

```bash
source setup/lib/install-slug.sh
VOICE_UNIT="$(systemd_unit)-local-voice"
mkdir -p ~/.config/credstore.encrypted
chmod 700 ~/.config/credstore.encrypted
```

In the operator's own interactive terminal, create an encrypted systemd credential:

```bash
systemd-creds encrypt --name=picovoice_access_key - \
  "$HOME/.config/credstore.encrypted/${VOICE_UNIT}-picovoice"
```

The command reads the AccessKey interactively. Do not ask the operator to reveal it.

## Install

Pass the downloaded model to the installer:

```bash
bash services/local-voice/install-systemd.sh /path/to/hey-nanoclaw_en_linux.ppn
```

The installer:

- copies the model with owner-only permissions;
- creates `data/local-voice/config.json` containing non-secret settings;
- creates an isolated Python venv and installs exact dependency versions;
- installs and starts a slug-scoped systemd user service;
- restarts the NanoClaw host so the adapter reads the new config.

## Wire to an agent

List agent groups, choose one, then create the local DM-style channel:

```bash
pnpm ncl groups list
pnpm exec tsx scripts/init-local-voice.ts --agent-group-id <group-id>
```

The default device/platform ID is `local`. To run another microphone sidecar,
pass the same custom ID to both the wiring script and sidecar:

```bash
pnpm exec tsx scripts/init-local-voice.ts \
  --agent-group-id <group-id> \
  --device-id desk
```

## Tune

The defaults are:

- Porcupine sensitivity: `0.65`
- VAD mode: `2`
- trailing silence: `900 ms`
- speech-start timeout: `3 s`
- maximum command: `20 s`
- OpenAI request timeout: `60 s`
- agent-response timeout: `120 s`

Edit the systemd `ExecStart` arguments to tune these values. Raise sensitivity
for missed wakes; lower it for false activations. After editing:

```bash
source setup/lib/install-slug.sh
systemctl --user daemon-reload
systemctl --user restart "$(systemd_unit)-local-voice"
```

List microphone indices with:

```bash
data/local-voice/venv/bin/python \
  services/local-voice/local_voice.py --list-devices
```

## Validate

```bash
pnpm run build
pnpm exec vitest run \
  src/local-voice.test.ts \
  src/local-voice-registration.test.ts \
  src/local-voice-openai.test.ts
python3 -m unittest services/local-voice/test_local_voice.py

source setup/lib/install-slug.sh
systemctl --user status "$(systemd_unit)-local-voice"
```

Say “Hey NanoClaw”, wait for the wake indication, then speak one request. Check
only status/error metadata in logs; do not add audio or transcript logging.
