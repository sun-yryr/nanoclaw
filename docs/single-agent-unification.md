# 1エージェント統合 — 方針とメリデメ

このフォークのペルソナは「真冬」一人の生活パートナーである。一方でランタイムは **agent group / session / container / provider** が別物として動くため、会話するたびに「別の agent が起きている」ように見える。このメモは、どこまでを1つにまとめるか、まとめると何が簡単になり何が難しくなるかを整理する。実装には入らない。

関連: [isolation-model.md](isolation-model.md)、[architecture.md](architecture.md)、[db.md](db.md)。

---

## いま「複数の agent」に見えるもの

実体は agent が何体もいるのではなく、**4つの層が独立して増える**ことである。

```
チャネル (Discord / Telegram / 音声 …)
    ↓  wiring (messaging_group_agents)
agent group  …… 人格・CLAUDE.md・メモリ・container.json・OneCLI agent
    ↓  session_mode
session      …… 会話履歴・provider の resume id・inbound.db / outbound.db
    ↓  wakeContainer(session)
container    …… Docker 1プロセス。キーは session.id（group ではない）
    ↓  AGENT_PROVIDER
provider     …… claude / cline / opencode
```

| 層 | 何が分かれるか | 増える典型トリガー |
|---|---|---|
| **agent group** | 人格、ワークスペース、Mnemon、スキル、container config、OneCLI の agent id | `/init-first-agent` が `dm-with-<name>` で新規作成。チャネル承認の「Connect new agent」。`create_agent`（agent-to-agent） |
| **session** | 会話コンテキスト、Claude/Cline の resume | `session_mode=shared` ならチャネルごと。`per-thread` ならスレッドごと。Discord グループは wiring を無視して **per-thread を強制**する（`src/router.ts`） |
| **container** | 実行プロセス、マウント、ハートビート | `wakeContainer` は session 単位。同じ group でもセッションが 5 本あればコンテナも 5 本 |
| **provider** | 推論バックエンド | group または session の `agent_provider` |

音声（Discord voice / local wake-word）は別 agent ではない。ホストが STT したあと、通常の inbound と同じ経路で既存 session に乗る。配線先の agent group が同じなら、テキストと同じ「真冬」である。

個人利用で本当に必要な境界はほぼない。仕事と私用を情報隔離したい場合だけ、agent group を分ける意味がある（isolation level 3）。

---

## 統合の段階

下に行くほど変更が大きく、upstream 追従コストも上がる。このフォークでは **A → B までを既定**とし、C は痛みが出てから、D はやらない、が妥当である。

### A. 運用で1 group に寄せる（コード変更なし）

既存の `agent_groups` を1行にし、全 `messaging_groups` をそこに配線する。session_mode は次の2択。

| mode | 会話 | メモリ / CLAUDE.md / コンテナ設定 | コンテナ数 |
|---|---|---|---|
| `shared`（推奨） | チャネル（またはスレッド）ごとに独立 | 共有 | 起きている会話の数 |
| `agent-shared` | 全チャネルが1本の会話 | 共有 | 最大1 |

これは isolation-model の level 2 / level 1 そのもので、すでに実装済みである。

作業の目安:

1. `ncl groups list` と wirings を見て、余っている group を特定する
2. 配線を残す1 group に付け替える（`session_mode=shared`）
3. 使わない group の sessions / destinations / members を掃除してから group を消す
4. 今後チャネルを足すときは「Separate agent」を選ばない

Discord グループチャットだけ例外がある。`adapterSupportsThreads && is_group` のとき router が `session_mode` を `per-thread` に上書きする。A だけだと Discord スレッドの数だけコンテナが増える。

### B. 「新規 group を作らない」を既定にする（小さなコード変更）

A をやっても、次の経路がまた group を増やす。

- `setup/register.ts` — `--folder` が新しいと agent group を作る
- `src/modules/permissions/` — チャネル承認カードの「Connect new agent」
- `src/modules/agent-to-agent/create-agent.ts` — コンテナ内からの `create_agent`（`cli_scope=global` なら承認なし）
- `/init-first-agent` — 初回以外に再実行すると別 folder になり得る

方針:

- register / チャネル承認のデフォルトを「既存の唯一の group に配線」にする
- 「Connect new agent」と `create_agent` は隠すか、明示フラグなしでは動かさない
- Discord の per-thread 強制を opt-in にする（個人アシスタントではスレッド＝別人格である必要がない）

エンティティモデル（テーブル、ncl、fan-out）は残す。増えないように栓をするだけである。

### C. 1 group = 1 container（大きなランタイム変更）

session は会話単位として残し、**起きているプロセスだけ group 単位にまとめる**。

いま:

```
wakeContainer(session)
  → nanoclaw-v2-<folder>-<timestamp>
  → agent-runner はその session の inbound.db だけを poll
```

案:

```
wakeContainer(agentGroup)
  → nanoclaw-v2-<folder>  （stable name）
  → agent-runner が group 配下の session DB をまとめて poll
  → 応答は session の outbound.db に書く（宛先はそのまま）
```

これが「管理は楽、実装は簡単にならない」層である。理由は後述の制約。

### D. エンティティモデルを1 agent に潰す（非推奨）

`agent_groups` / `messaging_group_agents` / `agent_group_members` / scoped admin / `create_agent` / fan-out を削除し、messaging group が直接「その agent」に届く形にする。

v1 の `registered_groups` に戻る方向で、v2 が意図して分けた many-to-many を捨てる。このフォークの日常運用には十分だが、`/update-nanoclaw` のたびに衝突し、upstream の PR Factory パターン（worker / manager / supervisor）も使えなくなる。テーブルは1行のまま残し、運用と B の栓で足りる。

---

## メリット / デメリット

### A. 運用統合（1 group、`shared`）

**メリット**

- 人格・Mnemon・`CLAUDE.md`・スキル・`container.json`・OneCLI agent が1つになる。カスタマイズの編集先が1フォルダ
- 実装ゼロ。upstream 追従はそのまま
- `ncl groups` が1行。restart / config / MCP 追加が1回で全チャネルに効く
- Discord テキストと Discord 音声と Telegram が同じ「真冬」になる（会話履歴はチャネルごと）

**デメリット**

- 起きている会話の数だけコンテナは残る。RAM / Docker / `MAX_CONCURRENT_CONTAINERS`（既定 5）の圧迫は残る
- 会話コンテキストはチャネル間で共有されない。跨いで覚えるのは Mnemon とファイルだけ
- Discord スレッド強制が残ると、見た目の「複数 agent」はあまり減らない
- 本当に隔離したいチャット（他人がいるグループ等）まで同じメモリに入る

### A'. 運用統合（1 group、`agent-shared`）

**メリット**

- コンテナも session も原則1つ。管理上いちばん単純
- チャネルをまたいだ「さっき Discord で言った件」がそのまま使える

**デメリット**

- 全チャネルのメッセージが1コンテキストに混ざる。窓がすぐ埋まる
- Discord スレッド・Telegram DM・音声が同じ履歴になり、宛先取り違えが起きやすい（typing はすでに agent-shared 特例あり）
- スケジュール task も同じ session の inbound に載るので、朝の briefing が雑談コンテキストを汚す

個人の「全部まとめて1人」には魅力があるが、コンテキスト汚染の方が高い。第一選択は `shared`。

### B. 増殖防止

**メリット**

- A の状態が時間が経っても壊れない
- チャネル追加・承認フローの分岐が減る（「新しい agent を作りますか」が消える）
- `create_agent` による意図しないサブ agent（別コンテナ・別メモリ）がなくなる

**デメリット**

- 後から本当に隔離したくなったときの逃げ道を、明示フラグか ncl 手動作成として残す必要がある
- register / permissions / agent-to-agent にフォーク差分が乗る。skill 化できるならその方が `/update-nanoclaw` に強い

### C. 1 container per group

**メリット（運用・リソース）**

- Docker が group あたり1本。アイドル kill・heartbeat・orphan cleanup・`ncl groups restart` が1対象
- デバッグが1ログ。いまは `--rm` のため session が死ぬとログも消えるが、対象が減るだけでも楽
- OneCLI `ensureAgent` と image tag（per-group image）が session 起動のたびに走らない
- 同時会話が多くても `MAX_CONCURRENT_CONTAINERS` に当たらない

**デメリット（実装が簡単にはならない）**

1. **poll-loop は単一 query 前提。** 会話中は `provider.push()` で同じ query に追記する。別 session のメッセージを同じ query に混ぜると履歴が壊れる。複数 `provider.query()` の並行か、キューイング（他チャネルは待つ）が要る。
2. **provider の resume は会話単位。** Claude / Cline は session id をディスクに持つ。コンテナを共有しても、ターンごとに resume 先を切り替える必要がある。Cline の snapshot は `~/.claude/cline-sessions/<id>.json` で session 単位。
3. **2-DB split は「1ファイル1ライター」。** コンテナが N 個の inbound を読む・N 個の outbound に書くのは不変条件的には合法（session ごとにファイルが分かれている）だが、poll・heartbeat・corruption 時のプロセス exit（「再マウントしないと直らない」）が **全 session を巻き込む**。いまは1 session の破損で1コンテナだけ死ぬ。
4. **マウント。** `/workspace` は session フォルダ、`/workspace/agent/` が group。1コンテナが複数 session を持つなら、workspace を group 側にするか、session をサブディレクトリにするか、設計を変える。
5. **同時応答の取り違え。** outbound の routing は session の default reply か明示 destination。多重 query を間違えると Discord に Telegram の返事が飛ぶ。
6. **idle / stuck sweep。** いまの天井（heartbeat 30 分、claim stuck 60 秒）は session コンテナ単位。group コンテナだと「1チャネルが Bash 中 → 他チャネルの stuck 判定が伸びる」または逆に「静かだったチャネルの天井で全体が死ぬ」。

要するに、ホスト側の「何本 spawn するか」は単純になるが、runner 側にマルチセッションオーケストレーションが移る。コード量は一時的に増える。

### D. モデル崩壊

**メリット**

- `ncl groups` / wirings / members / scoped admin が消える
- router の fan-out（`messageIdForAgent`）が消える

**デメリット**

- ほぼ全面書き直し。migration、CLI、権限、delivery、agent-to-agent が連鎖する
- upstream 追従が実質フォーク固定になる
- 将来「このグループだけ別メモリ」が欲しくなったとき、捨てたテーブルを戻すことになる

---

## 実装が簡単になるか

| やりたいこと | 簡単になるか | 理由 |
|---|---|---|
| 人格・メモリ・スキルの編集 | **なる（A）** | 編集先が `groups/<one>/` と `container/CLAUDE.md` に固定される |
| チャネル追加 | **なる（A+B）** | 配線だけ。group 作成フローが消える |
| コンテナ運用・再起動・ログ | **なるのは C** | A だけでは session 数だけ残る |
| agent-runner / provider / 2-DB | **ならない（C で増える）** | 単一 session poll の単純さが売り。マルチセッション化はその単純さを捨てる |
| ncl / DB スキーマ | **D 以外はほとんど変わらない** | テーブルを1行運用する方が、テーブルを消すより安い |
| `/update-nanoclaw` | A は無影響。B は小さな差分。C/D は衝突しやすい | |

「複数 agent を1つにすると実装が簡単になる」は、**identity（group）の話としては正しい**。**実行プロセス（container）まで1つにすると、実装は難しくなり、運用は楽になる。** その区別がこのメモの結論である。

---

## 推奨する進め方

このフォーク向け。

1. **今すぐ（A）** — 実 DB を見て agent group を1つに寄せ、全チャネルを `session_mode=shared` で配線する。音声チャネルも同じ group にする。
2. **次（B）** — 新規 group 作成経路を塞ぐ。Discord の per-thread 強制を個人用途では切る。これで「いつの間にか別 agent」が止まる。
3. **C は計測してから** — `MAX_CONCURRENT_CONTAINERS` に当たる、同時に何本も Docker が起きてホストが重い、restart が session 数だけ走る、が実際に痛いときだけ。先にキューイング（同時1会話、他は待つ）で十分かも知れない。並行マルチ query は最後。
4. **D はやらない。**

C に進むときの最低条件（設計を変えないと壊れる不変条件）:

- inbound / outbound の単一ライターは session ファイル単位で維持する（1つの巨大 DB にマージしない）
- provider resume id は session に紐づけたまま（group で共有しない）
- 同時に動かす query は「同じ session だけ push、違う session は別 query か待機」
- heartbeat は group コンテナ1本でも、stuck 判定は session（claim）単位
- `on_wake` の「死にかけコンテナがメッセージを盗まない」契約を、group 再起動でも保つ
