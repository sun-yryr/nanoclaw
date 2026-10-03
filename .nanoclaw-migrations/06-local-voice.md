# Local Voice — QUARANTINE

`SOURCE=5183f47ac903b36fa325d24900cfd5fb499149d1`

**Intent:** Keep the Porcupine wake-word + OpenAI STT/TTS Linux microphone channel code in the tree for later, but **do not connect it** to the running host.

## Copy from SOURCE (inactive)

- `.claude/skills/add-local-voice/`
- `src/channels/local-voice.ts`
- `src/channels/local-voice-openai.ts`
- `src/local-voice.test.ts`
- `src/local-voice-openai.test.ts`
- `src/local-voice-registration.test.ts` — if this test requires barrel registration, either skip copying the test or adjust it to expect **no** registration.
- `scripts/init-local-voice.ts`
- `services/local-voice/` (python service, systemd installer, requirements, tests)

## Must NOT do

- Do **not** add `import './local-voice.js';` to `src/channels/index.ts`.
- Do **not** run `scripts/init-local-voice.ts`.
- Do **not** enable the systemd unit / start the Python service as part of migration.
- Do **not** require local-voice deps for host boot.

## Later activation

Follow `.claude/skills/add-local-voice/SKILL.md`: append the barrel import, install service, configure env, restart host.