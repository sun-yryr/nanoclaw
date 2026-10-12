# Gateway vault for Cline SIWC

## Decision

SIWC on `api.openai.com` must use a **generic Bearer** secret. Do not use the
gateway `chatgpt` OAuth profile or OneCLI `type: openai` — those inject
`ChatGPT-Account-Id`, and SIWC returns `400 invalid_request` when that header is
present. SIWC JWTs omit `chatgpt_account_id`; Bearer-only succeeds.

| Field | SIWC value |
|-------|------------|
| `name` | `Cline SIWC` (dedicated; never share with OpenCode / Codex ChatGPT entries) |
| `host` | `api.openai.com` |
| `kind` | `api-key` (generic) |
| `injection` | `Authorization: Bearer {value}` |
| `proxyValue` | `nc-cline-siwc-v1` (OneCLI ignores; Iron may use) |
| vault value | SIWC **access_token** only |
| local file | `data/siwc/session.json` — refresh_token + client_id + expiresAt (mode `0600`) |

## Refresh (host)

OpenAI access tokens last **one hour**; refresh tokens last **30 days** and
rotate on each use ([token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)).

- Host module `src/modules/siwc-refresh/` runs a check loop (~60s) and refreshes
  when access expires within 5 minutes.
- Refresh POSTs to `https://auth.openai.com/api/accounts/oauth/token` from the
  **host** (not the agent proxy), then writes a new access token into the vault.
- Failures are **log-only**. Discord notices come from the agent when a turn
  still gets 401 / expired-token errors.
- Unusable refresh (`invalid_grant`, etc.) sets `needsReauth` — operator re-runs
  `run-cline-siwc-auth.ts`.

## Ordering

1. Browser SIWC registration → issued `client_id` + tokens + scopes  
2. Delete any legacy `openai`-type `Cline SIWC` row  
3. `connection({ kind: 'api-key', host: api.openai.com, … })` then `save(access_token)`  
4. Write `data/siwc/session.json` (access + refresh + expiry)  
5. `modelEndpoint('https://api.openai.com/v1').configure()` when the gateway has an allowlist  

`client_id=dynamic_agent_client` is only the authorization entrypoint, never a
stored vault client id.

## Host id

Persist `ext_agent_host_id` once per install at `data/siwc/host-id` (mode `0600`).
Opaque `urn:uuid:…`. Not a credential.

## Non-goals

- Codex CLI `auth.json`
- Shared vault with OpenCode ChatGPT (`chatgpt.com`) or `/add-codex`
- OneCLI-native SIWC oauth profile (pin cannot refresh Bearer-only today)
- Container-side refresh or mounting refresh_token into the agent
- Host→Discord push on refresh failure (agent turn errors own that surface)
