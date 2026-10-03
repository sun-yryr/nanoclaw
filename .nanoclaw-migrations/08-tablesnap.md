# tablesnap + discord-formatting (KEEP)

`SOURCE=5183f47ac903b36fa325d24900cfd5fb499149d1`

**Intent:** Agents render markdown tables as PNG for Discord. Japanese text needs IPA Gothic via build-time patch + `TABLESNAP_FONT`.

## Copy as-is from SOURCE

- `container/tablesnap/cjk-font.patch`
- `container/skills/tablesnap/SKILL.md`
- `container/skills/discord-formatting/SKILL.md`
- `.claude/skills/add-tablesnap/` (fork recipe includes CJK steps)
- `src/tablesnap-dockerfile.test.ts`

## Dockerfile blocks (from SOURCE)

1. Go build stage that clones tablesnap at `TABLESNAP_VERSION`, applies `cjk-font.patch`, installs binary.
2. Apt: `fonts-ipafont-gothic`
3. Env: `TABLESNAP_FONT=/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf`

CJK patch must prefer `TABLESNAP_FONT` then IPA Gothic paths (see patch file).

## Interaction

`discord-formatting` skill tells the agent to use tablesnap + `send_file` for tables, and not to emit `[url](url)` identical links (host also unwraps — belt and suspenders).

## Verification

- Dockerfile tests assert patch + font env.
- Manual: agent can produce a Japanese table PNG without tofu.