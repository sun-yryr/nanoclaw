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
| stored value | SIWC **access_token** only |

Refresh: re-run the SIWC browser login when the access token expires.

## Ordering

1. Browser SIWC registration → issued `client_id` + tokens + scopes  
2. Delete any legacy `openai`-type `Cline SIWC` row  
3. `connection({ kind: 'api-key', host: api.openai.com, … })` then `save(access_token)`  
4. `modelEndpoint('https://api.openai.com/v1').configure()` when the gateway has an allowlist  

`client_id=dynamic_agent_client` is only the authorization entrypoint, never a
stored vault client id.

## Host id

Persist `ext_agent_host_id` once per install at `data/siwc/host-id` (mode `0600`).
Opaque `urn:uuid:…`. Not a credential.

## Non-goals

- Codex CLI `auth.json`
- Shared vault with OpenCode ChatGPT (`chatgpt.com`) or `/add-codex`
- Unattended refresh until a gateway can inject Bearer without Account-Id
