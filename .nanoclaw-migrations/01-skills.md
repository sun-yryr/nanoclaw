# Applied Skills

`SOURCE=5183f47ac903b36fa325d24900cfd5fb499149d1`

## Re-apply during upgrade

| Skill | Notes |
|-------|--------|
| `/add-discord` | From `channels` branch on official remote. Then apply `03-discord.md` overlays. |
| `/add-discord-voice` | Implementation is in-tree (not channels branch). Copy from SOURCE per `05-discord-voice.md`. Keep skill docs under `.claude/skills/add-discord-voice/`. |
| `/add-gcal-tool` | If skill exists on new base, run apply; else copy Dockerfile calendar block from SOURCE. |
| `/add-gmail-tool` | Same pattern. |
| `/add-gtasks-tool` | Same pattern. |
| `/add-mapbox-tool` | Same pattern. |
| `/add-tablesnap` | Prefer fork skill from SOURCE (includes CJK). See `08-tablesnap.md`. |

## Quarantine (copy skill + code, do not activate)

| Skill | Notes |
|-------|--------|
| `/add-local-voice` | Copy files from SOURCE. **Do not** add `import './local-voice.js'` to `src/channels/index.ts`. Do not run `scripts/init-local-voice.ts` or enable systemd unit. |

## Skip / DROP

| Skill | Notes |
|-------|--------|
| `/add-opencode` | Not wanted. Remove any leftover fork OpenCode if present. |
| `/add-gdrive-tool` | Explicitly dropped. |
| `/add-manual-memory` | Not applied as stock skill; memory comes via Cline+mnemon port. |
| `/add-mnemon` | Partial historically; use Dockerfile+Cline tools from SOURCE rather than incomplete hook-based apply. |

## Custom skills / docs to copy as-is from SOURCE

- `.claude/skills/add-discord-voice/`
- `.claude/skills/add-local-voice/` (quarantine)
- `.claude/skills/add-tablesnap/` (CJK-aware)
- `.claude/skills/add-gcal-tool/`, `add-gmail-tool/`, `add-gtasks-tool/`, `add-mapbox-tool/` if still useful as recipes
- `docs/single-agent-unification.md`

## Do not treat as migration targets

Recipe-only skills present under `.claude/skills/` but never applied (Telegram, Slack, …) — leave whatever upstream ships; no need to copy fork-only unused recipes unless you want them.