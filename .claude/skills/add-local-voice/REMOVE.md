# Remove Local Voice

Reverse every change made by `/add-local-voice`.

## Stop and remove the service

```bash
source setup/lib/install-slug.sh
VOICE_UNIT="$(systemd_unit)-local-voice"
systemctl --user disable --now "$VOICE_UNIT"
rm -f "$HOME/.config/systemd/user/${VOICE_UNIT}.service"
rm -f "$HOME/.config/credstore.encrypted/${VOICE_UNIT}-picovoice"
systemctl --user daemon-reload
```

## Remove runtime state

```bash
rm -rf data/local-voice
rm -f data/local-voice.sock
```

Remove the `local-voice` messaging group, wiring, membership, and user with the
normal `ncl` resources if they are no longer used. Do not modify the central DB
with raw SQL.

## Remove source files

```bash
rm -f src/channels/local-voice.ts src/channels/local-voice-openai.ts
rm -f src/local-voice.test.ts src/local-voice-registration.test.ts src/local-voice-openai.test.ts
rm -rf services/local-voice
rm -f scripts/init-local-voice.ts
```

Delete this barrel import from `src/channels/index.ts`:

```ts
import './local-voice.js';
```

## Validate

```bash
pnpm run build
pnpm test
```
