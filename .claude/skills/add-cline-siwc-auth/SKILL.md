---
name: add-cline-siwc-auth
description: >-
  Wire Sign in with ChatGPT (official SIWC) as auth for an existing Cline
  provider group, keeping openai-native Responses to api.openai.com/v1. Use when
  adding ChatGPT Plus/Pro plan usage to Cline without Codex CLI, openai-codex,
  or chatgpt.com/backend-api/codex. Triggers on "SIWC", "Sign in with ChatGPT",
  "Cline ChatGPT subscription", "cline siwc auth".
---

# Cline に Sign in with ChatGPT 認証を載せる

既存の Cline プロバイダはそのまま使う。変えるのは認証だけである。推論は今どおり `openai-native`（Responses API）で `https://api.openai.com/v1` に送る。Codex CLI、`providerId: openai-codex`、`chatgpt.com/backend-api/codex` は使わない。

前提: NanoClaw は個人の PC 上で動かす。公式 SIWC の OSS・ローカル対象に合う。

## やらないこと

- `ncl groups config update --provider codex` への切り替え
- Codex CLI ログインや `~/.codex/auth.json` をコンテナへ載せる経路
- Cline の `providerId: openai-codex`
- コンテナ内でのブラウザ OAuth / device code
- `.env` への access / refresh トークンの直書き
- 既存の Codex CLI 向け gateway `chatgpt` 接続（`chatgpt.com` + Account-Id）との共有
- OneCLI `type: openai` / gateway `profile: chatgpt` への SIWC 保存（`ChatGPT-Account-Id` が付き 400 になる）

## 目標の形

```
[ホスト] SIWC サインイン（動的 client_id + host id）
    → gateway vault「Cline SIWC」（generic Bearer、api.openai.com）
    → 回線上で Authorization だけ差し替え
[コンテナ] Cline Agent
    CLINE_AUTH_MODE=siwc
    providerId: openai-native
    baseUrl: https://api.openai.com/v1
    apiKey: siwc-sentinel
```

公式ドキュメント:

- https://developers.openai.com/siwc/token-sharing-open-source
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations

設計メモ: [references/phase1-design.md](references/phase1-design.md)

## 1. ホストで SIWC サインイン → vault

コールバックは `http://127.0.0.1:1455/auth/callback`（`--port` / `SIWC_CALLBACK_PORT` で変更可）。

```bash
# リポジトリルート。選択中の gateway が connection() を提供していること。
pnpm exec tsx .claude/skills/add-cline-siwc-auth/scripts/run-cline-siwc-auth.ts
```

no-GUI ホスト（GUI 機から）:

```bash
ssh -L 1455:127.0.0.1:1455 user@nanoclaw-host
# ホストで上記 CLI を実行し、表示された authorize URL を GUI 機のブラウザで開く
```

1. ChatGPT にログインし、plan usage を許可する。
2. host id は `data/siwc/host-id`。発行 client id は `data/siwc/registration.json`（トークンは書かない）。
3. `chatgpt.tokens.use.direct` が無ければ失敗して終了する。
4. 成功時は gateway の `Cline SIWC` に **access_token を generic Bearer** で保存し、`data/siwc/session.json` に refresh 用セッションを書く。古い `openai` 型の同名エントリは CLI が削除する。
5. ホストの `siwc-refresh` モジュールが access（約1時間）を自動 refresh する。refresh 不能時だけ同じコマンドで再ログインする。

手動 refresh（デバッグ）:

```bash
pnpm exec tsx .claude/skills/add-cline-siwc-auth/scripts/refresh-cline-siwc.ts
pnpm exec tsx .claude/skills/add-cline-siwc-auth/scripts/refresh-cline-siwc.ts --force
```

テスト:

```bash
pnpm exec vitest run .claude/skills/add-cline-siwc-auth/scripts/siwc-login.test.ts
pnpm exec vitest run .claude/skills/add-cline-siwc-auth/scripts/cline-siwc-vault.test.ts
pnpm exec vitest run src/modules/siwc-refresh/refresh.test.ts
```

## 2. `.env` とホスト再起動

トークンは書かない。

```bash
CLINE_AUTH_MODE=siwc
CLINE_MODEL=gpt-6.1-sol   # ChatGPT plan で使える slug。OpenCode / Luna ID は不可

# 子を OpenCode Go にする場合（親だけ SIWC のまま）:
CLINE_SPAWN_MODEL=deepseek-v4.1-flash
CLINE_SPAWN_BASE_URL=https://opencode.ai/zen/go/v1
# CLINE_SPAWN_API は省略可（chat）
```

`CLINE_API` / `CLINE_REASONING_EFFORT` は SIWC 親では不要（親は常に Responses。effort 未設定ならモデル既定）。

ホスト再起動後、必要なら `ncl groups restart --id <group>` でコンテナに env を載せる。

## 3. コンテナ側の挙動（実装済み）

触るファイル: `container/agent-runner/src/providers/cline-siwc.ts`、`cline.ts`、`cline-spawn.ts`、`src/providers/cline.ts`。

1. `CLINE_AUTH_MODE=siwc` → `openai-native`、`https://api.openai.com/v1`、`siwc-sentinel`。
2. fetch 書き換えで Responses に `store: false` を付け、`truncation` など preview 禁止フィールドを落とす。
3. MCP deferral / クライアント `tool_search` はオフ。
4. `x-opencode-session` は付けない。
5. spawn はデフォルトで SIWC に乗せない。子を SIWC にするには `CLINE_SPAWN_AUTH_MODE=siwc`。別エンドポイントなら `CLINE_SPAWN_BASE_URL`（`api.openai.com` 以外が必須）。

テスト:

```bash
cd container/agent-runner && bun test src/providers/cline-siwc.test.ts src/providers/cline-spawn.test.ts src/providers/cline.test.ts
```

## 関連だが別物

| 経路 | 使う場面 |
|------|----------|
| `/add-codex` | Cline ではなく Codex app-server をエージェントにする |
| Codex CLI 向け gateway `chatgpt` | `chatgpt.com` + Account-Id。本スキルの SIWC とは別 |

## Troubleshooting

- **401 / sharing 不足**: `chatgpt.tokens.use.direct` が無い。再同意する。
- **400 `invalid_request` + Account-Id**: vault が `openai` / chatgpt OAuth 型になっていないか確認する。generic Bearer に戻す。
- **usage limit**: ChatGPT Settings の Usage。`subscription_sharing_usage_limit_exceeded` など。
- **unsupported parameter**: preview limitations。fetch rewrite が効いているかコンテナログの `SIWC fetch rewrite installed` を見る。
- **spawn=off**: SIWC 親で `CLINE_SPAWN_BASE_URL` が無いと子は無効。
- **トークン期限切れ（Discord に expired が出る）**: ホストログで SIWC refresh を確認。`needsReauth` / refresh 失敗なら `run-cline-siwc-auth.ts` を再実行。初回だけ session.json が無い場合も再ログイン（古い vault のみの状態）。
- **ホストが refresh していない**: `CLINE_AUTH_MODE=siwc` または `data/siwc/session.json` があること。ホスト再起動後に `SIWC refresh loop started` が出ること。
