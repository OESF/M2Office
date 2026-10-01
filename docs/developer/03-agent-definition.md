# 3. 業務エージェントの書き方

**業務エージェントは、スキルの形式（SKILL.md）で書きます**（仕様書 第12.12節）。第3.0節がそのリファレンスです。
JSON で書く定義（`manifest.json`＋`agents/*.json`）は**第 0.131.0 版で廃止しました**。取り込もうとすると「SKILL.md で書いてください」と断ります
（M2Office の中では、SKILL.md を中の定義に組み立てて動かします。書く人が触る必要はありません）。

## 3.0 SKILL.md（標準）

スキル（Claude Code の Skills・Agent Skills）の書き方のまま書きます。**M2Office で覚えることは第2章の冒頭の 4 つだけ**です。

### スキルの項目の扱い

| スキルの項目 | M2Office での扱い |
|---|---|
| `name` | 業務の ID の一部（`<拡張機能の ID>:<name>`）。省けばフォルダの名前 |
| `description` | メニューの説明と、秘書が業務へ取り次ぐ手がかり。省けば本文の最初の行 |
| `when_to_use` | `description` に添えて、秘書の取り次ぎの手がかりにする |
| 本文の最初の見出し（`# 〇〇`） | 画面に出す業務の名前。無ければ `name` |
| 本文 | 業務の指示（推論が読む） |
| `argument-hint` | 入力の欄に薄く出る例 |
| `arguments` | 入力の欄（1 つの名前が 1 つの欄）。無ければ自由記入の「依頼」の欄 1 つ |
| `$ARGUMENTS`・`$ARGUMENTS[N]`・`$N`・`$名前` | 実行のときに入力で置き換える（`\$` は `$` のまま） |
| `disable-model-invocation: true` | 秘書は取り次がない。メニューからだけ使う |
| `user-invocable: false` | メニューに出さない。秘書が取り次いだときだけ使う |
| `allowed-tools` | **M2Office のツールの一覧**（第4章）。書いたツールしか使えない。書かなければ読むだけのツール（`knowledge.search`・`file.read_text`）、`""` ならツールなし。M2Office に無いツール（`Bash`・`Read` など）は無視して知らせる |
| `effort` | `low` は高速のモデル、`medium`・`high` は標準、`xhigh`・`max` は高性能のモデル（上限もトークン 30 万・時間 10 分に広がる。長い文書を読む業務向け） |
| `model`・`context`・`agent`・`background`・`disallowed-tools`・`hooks`・`paths`・`shell` | 使わない（知らせる） |
| `license`・`compatibility`・`metadata` | 保つ。`metadata.version`・`metadata.author` は拡張機能の版と提供者 |
| `connectors/*.json` | 外部のサービス（MCP サーバ）をつなぐコネクタの宣言。SKILL.md と同じフォルダに置き、そのツールを `allowed-tools` に `<コネクタの ID>.<ツール>` で書く（第7章） |
| `allowed-tools` の `<接続の ID>.<ツール>`（同梱しない） | 会社がすでに登録した接続（MCP）のツールを使う。その会社に接続が無ければ、業務は使えない（第7.2節） |
| 補助のファイル（`reference.md`・`examples.md` など） | スキルと同じく、本文から参照したものを推論が必要なときに読む（ツール `skill.read` が自動で付く）。Markdown・テキストのみ |
| `scripts/`・`` !`コマンド` ``・`${CLAUDE_SKILL_DIR}` | 動かさない。ファイルは除き、コマンドは消して知らせる |

### M2Office で足すもの

| もの | 使うとき |
|---|---|
| `HELP.md` | 利用者向けの説明。業務の題名の「？」とヘルプセンターに出る |
| `metadata.m2office-id` | 他の会社に配るときの ID（逆ドメイン名）。無ければ `skill.<name>`（自社専用） |
| `metadata.m2office-inputs` | 欄に種類を付けたいとき。1 行に 1 つ「欄の名前: 種類」（`短文`・`長文`・`日付`・`ファイル`、後ろに「（任意）」） |
| `metadata.m2office-examples` | 業務の説明に実行例のボタンを出したいとき（1 行に 1 つ） |
| `metadata.m2office-approver` | 社外に出すものを依頼した本人以外が承認するとき（`承認者`・`管理者`） |
| `metadata.m2office-private` | 結果を秘書の記憶に入れたくないとき（契約書など機密の業務）。`"true"` と書くと、秘書はその結果から学ばない |

### M2Office が組み立てるもの

段・承認の段・入力のフォーム・権限の同意は、取り込むときに M2Office が作ります。
送るツール（`gmail.send`・`chat.post` など）を `allowed-tools` に書けば「作業 → 承認 → 送る」になり、
社外にもお金にも関わらなければ、承認は自動で通ります。結果は、最後に返した文がそのまま出ます。

## 3.1 版の上げ方

版は `metadata.version`（セマンティックバージョニング）に書きます。

| 変えたもの | 上げるもの |
|---|---|
| 指示の言い回し、HELP.md | 3 番目（`1.0.0` → `1.0.1`） |
| 入力の欄の変更 | 2 番目（`1.0.0` → `1.1.0`） |
| `allowed-tools` にツールが増える（使うツール・危険度が増える） | 1 番目（`1.0.0` → `2.0.0`）。導入済みの会社では、管理者が同意し直すまでその業務はお休みになる |
