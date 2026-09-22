---
name: release
description: Bump the M2Office service version across all workspace package.json files, draft a Japanese developer changelog entry in CHANGELOG.md and a plain-language user-facing note (help article in the "updates" category) from git history since the last tag, check README/package READMEs and the pre-release checklist in docs/release-process.md, run the tests, and create a release commit + annotated git tag. ONLY invoke this when the user explicitly types the /release slash command — this workflow commits and tags the real repository, so do not infer it from casual natural-language requests like "バージョンアップして" or "リリースして" on their own.
---

# M2Office リリース作業

機能追加や修正がまとまって安定したタイミングで、サービス本体の版を上げ、
**開発者向けのリリースノート（`CHANGELOG.md`）と利用者向けのリリースノート（ヘルプの「更新情報」）を書き、
リリースのコミットと注釈付きタグを作る**一連の作業を行う。
規定の正は [docs/release-process.md](../../../docs/release-process.md)（リリース規定）。このスキルはその第5章・第6章・第10章を実行する手順である。

**このワークフローは実際にリポジトリへコミット・タグを作成する。** 新しい版の番号と
リリースノートの文面は必ず三浦さんに提示し、明示的な了承を得てから git の操作に進むこと
（黙って決め打ちしない）。**push は絶対に自動で行わない。** 稼働中の開発サーバーも、確認なしに起動・再起動しない。

回答・リリースノート・コミットメッセージはすべて日本語で書く（プロジェクトの `CLAUDE.md`）。

## 引数（版の指定のしかた）

`/release` の後に任意で引数を渡せる。

- **`/release`（引数なし）** — 変更の内容から MAJOR / MINOR / PATCH を提案し、会話の中で確かめる
- **`/release 0.2.0`（具体的な番号）** — その番号を使う。ただし、今の版より大きいか、規模と釣り合っているかは一声確かめる
- **`/release major`** / **`/release minor`** / **`/release patch`** — 上げ幅だけを指定。今の版（ルートの `package.json`）からその桁を 1 つ上げた番号を示す

いずれの場合も、確定した番号とリリースノートの文面は手順 4 で提示して了承を得る。引数があっても確認を省かない。

## 手順

### 1. 前回のリリース以降の変更を把握する

```bash
git describe --tags --abbrev=0          # 直近のタグ（例: v0.2.0）
git log <直近のタグ>..HEAD --oneline     # タグ以降のコミット
git diff <直近のタグ>..HEAD --stat       # 変更したファイル（規模の把握）
git status --short                       # 未コミットの変更・未追跡のファイル
```

**タグが 1 つも無い場合**（最初のリリース）は `git log --oneline` で全履歴を見る。
最初のリリースでは、変更を 1 つずつ並べるのではなく、「最初の版に入っている機能」を分類ごとにまとめて書く。

未コミットの変更があれば、今回のリリースに含めるかを確かめる。無関係な作業中のファイルが混ざりうるため、
`git add -A` や `git add .` は使わず、含めるファイルをパスで明示して `git add` する。

変更の中から、次の**配備に関わる変更**を必ず拾い出す（リリースノートの「配備で行うこと」に書く）。

| 見るもの | 確かめ方 | 書くこと |
|---|---|---|
| データベースの移行 | `git diff <タグ>..HEAD --stat -- db/migrations` | 追加した移行のファイル名と、`npm run db:migrate` が要ること。**巻き戻せない移行**が無いか（列の削除・改名などは別リリースに分ける。リリース規定 第6.2節・第7章） |
| 環境変数 | `git diff <タグ>..HEAD -- .env.example` | 追加・変更した変数と既定値 |
| Google の権限 | `git diff <タグ>..HEAD -- packages/core/src/tools/` で、ツールの `google.scope` の変化を見る | 求める権限が増えたら、**再同意が要る**ことと対象（リリース規定 第3.1節で MAJOR 扱い） |
| 公開 API | `git diff <タグ>..HEAD --stat -- packages/api/src/routes` と `packages/api/README.md` | 追加・変更したエンドポイント。破壊的変更の有無 |
| エージェント定義スキーマ | `packages/shared` の `schema_version` | 変われば MAJOR の候補 |

### 2. 新しい版の番号を決める

リリース規定 第3章の判断に従う。

| 区分 | 該当する変更 |
|---|---|
| **MAJOR** | 公開 API の破壊的変更 / エージェント定義スキーマのメジャー更新 / 巻き戻せないデータ移行 / 既存の操作手順が変わる画面の改変 / **求める権限が増えた（再同意が要る）** / 上限値を厳しくした |
| **MINOR** | 機能の追加 / 新しいエージェントの追加 / 後方互換のある API の追加 / 既存の挙動を変えない既定値の追加 / 上限値を緩めた |
| **PATCH** | 不具合の修正 / 文言の修正 / 性能の改善 / 挙動が変わらない依存パッケージの更新 |

**迷ったら大きいほうに倒す**（リリース規定 第3.1節）。迷うときは素直に「MINOR と PATCH のどちらにしますか」と聞く。
いまは `1.0.0` より前（`0.x.y`）なので、MAJOR に当たる変更があったときは、`0.x` の MINOR を上げる運用でよいかを確かめる。

版を持つ場所（**すべて同じ番号にそろえる**）:
- ルートの `package.json` と `packages/*/package.json`（`shared`・`core`・`api`・`worker`・`web`）の `"version"`
- `package-lock.json` の、ルートと各ワークスペースの `"version"`
- `README.md` のタイトルのすぐ下の「現在の版」の行（無ければ、タイトルの直後に `> 現在の版: vX.Y.Z（YYYY-MM-DD）` を足す）

**版を上げないもの**: 仕様書（`specification.md` の `0.x.y`）、エージェント定義の `schema_version`、公開 API の `/v1`、
拡張機能の `manifest.json` の版、リリース規定・開発規約の版。これらは独立して動く（リリース規定 第2章）。

### 3. 事前の確認（リリース規定 第6.1節）を行う

次を実際に確かめ、結果を手順 4 でリリースノートの下書きと一緒に報告する。**確かめられなかった項目は「未確認」と明示する。**

| # | 確認事項 | 確かめ方 |
|---|---|---|
| 1 | 仕様書が更新済み | 変更した機能が `specification.md` にあるか。実装状況（第24.4節）が今の実装と合っているか。未決事項（第26章）の状態 |
| 2 | テスト（評価セットを含む）が通る | `npm test`（ファイルヘッダー・ヘルプ・ツールの一覧の確認と単体テスト） |
| 3 | 型とビルドが通る | `npm run typecheck` と `npm run build -w packages/web` |
| 4 | テナント境界のテストが通る | `npm run smoke`。**開発サーバー（`npm run dev`）とデータベースが動いているときだけ**実行できる。動いていなければ、起動してよいかを尋ねる。勝手に起動・再起動しない |
| 5 | データの移行と巻き戻しの手順 | 手順 1 で拾った移行について、巻き戻しの方法（移行を逆にする SQL、または前の版に戻しても動くこと）をリリースノートに書けるか |
| 6 | 利用者に見える変更について、ヘルプを更新した | 画面・文言・挙動の変更に対応する `docs/help/*.md` の変更があるか |
| 7 | README を更新した | 手順 5 |

失敗したものがあれば、**リリースを止めて**三浦さんに報告する。失敗を残したままコミット・タグを作らない。

### 4. リリースノートの下書きを作り、了承を得る

リリース規定 第5章のとおり、**読み手が違うので 2 種類を書き分ける。同じ文章を使い回さない。**

#### 4.1 開発者向け: `CHANGELOG.md`

新しい版が常にいちばん上に来る降順。イントロの直後に挿入する。形式:

```markdown
## vX.Y.Z <2〜3 語の日本語の概要>（YYYY-MM-DD）

### 配備で行うこと
- `npm run db:migrate`（移行 `016_knowledge_sections.sql`〜`018_google_data_retention.sql`）
- 環境変数 `RETENTION_INTERVAL_MS` を追加（既定: 本番 10 分）
- 巻き戻し: <手順。巻き戻せない変更が無いことも書く>

### 追加
- **<太字の短い見出し>** — <何を・なぜ・どう変えたか、を 1〜3 文で。ファイル名・API・仕様書の節を含める>

### 変更
### 非推奨
### 削除
### 修正
### セキュリティ
```

- 分類はリリース規定 第5.3節の 6 つ（追加・変更・非推奨・削除・修正・セキュリティ）。**該当が無い分類の見出しは書かない**
- 「配備で行うこと」は、手順 1 の配備に関わる変更が 1 つでもあれば必ず書く。無ければ「なし」と書く
- **非推奨には代替を必ず書く**（リリース規定 第5.3節）。公開 API の変更は省略しない
- 箇条書きは「1 コミット」ではなく「開発者にとって意味のある変更の単位」でまとめる。コミットメッセージを転記せず、背景（なぜ壊れていたか・なぜ要るか）まで書く
- 日付は今日の日付（YYYY-MM-DD）

#### 4.2 利用者向け: ヘルプの「更新情報」

管理者ページの「お知らせ」ができるまでは、ヘルプセンターの「更新情報」に記事として置く
（`docs/help/updates-vX-Y-Z.md`。版の `.` は `-` に置き換える）。形式:

```markdown
---
id: updates-vX-Y-Z
title: <平易な題名>（YYYY 年 M 月 D 日）
audience: all
category: updates
related: [<関係する記事の id>]
---
<利用者が何かをしなければならない場合、最初の段落に書く（リリース規定 第5.4節）>

## できるようになったこと
- ...

## 変わったこと
- <操作の手順が変わる場合は、変更前と変更後を並べる>

## 直したこと
- ...
```

- **業務の言葉で書き、専門用語を使わない**（仕様書 原則 u1）。例: 「承認の再開処理を修正」ではなく「承認のあとに処理が止まってしまう不具合を直しました」（リリース規定 第5.2節）
- 管理者だけに関わる内容（設定の画面の追加など）は、`audience: admin` の別の記事（`updates-vX-Y-Z-admin.md`）に分けてよい
- 権限の再同意が要る場合は、対象と理由を最初に書く
- 開発者にしか関係のない変更（テスト・内部の作り直し）は書かない。書くことが無ければ記事を作らず、その旨を伝える

#### 4.3 提示して了承を得る

**新しい版の番号・CHANGELOG の下書き・更新情報の下書き・手順 3 の確認結果・手順 5 の README の修正案を、まとめて提示し、
「この内容でコミットしてよいか」を確かめる。** 修正の指示があれば反映してから次に進む。

### 5. README がいまの実態に合っているかを確かめる

`README.md`（リポジトリ直下）と `packages/*/README.md` は、いまの実装を説明するリファレンスである。
開発規約では変更と同じコミットで README を直す決まりだが、漏れていないかをこのタイミングで点検する。

手順 1 の差分から、次の兆候を探す。

| 兆候 | 見る README |
|---|---|
| API のエンドポイントの追加・変更 | `packages/api/README.md` のエンドポイントの表 |
| 環境変数の追加・変更 | `README.md` の環境変数の表と `.env.example` |
| `core` のディレクトリ（`src/*`）の追加 | `packages/core/README.md` の構成 |
| ワーカーの見回り・定期処理の追加 | `packages/worker/README.md` |
| 画面のファイルの追加 | `packages/web/README.md` の構成 |
| 実装状況の変化 | `README.md` の実装状況の表 |
| 新しいツール | 開発者マニュアル 第4章（`npm run docs:tools` で作り直す。`npm test` が食い違いを検出する） |

兆候があれば、該当する節を実際に読んでから修正案を作る（想像で書かない）。
該当が無ければ「今回は README の構造的な更新は不要と判断しました」と一言添える。

### 6. ファイルを更新する

1. 版をそろえて上げる（`package.json` と `package-lock.json` をまとめて書き換える）:
   ```bash
   npm version X.Y.Z --workspaces --include-workspace-root --no-git-tag-version
   grep -n '"version"' package.json packages/*/package.json   # すべて X.Y.Z か確かめる
   ```
   `--no-git-tag-version` を必ず付ける（`npm version` にコミットとタグを作らせない。コミットとタグは手順 7・8 で作る）
2. `README.md` の「現在の版」の行を書き換える（無ければ足す）。手順 5 で了承を得た修正を反映する
3. `CHANGELOG.md` に新しいエントリを挿入する
4. 利用者向けの記事 `docs/help/updates-vX-Y-Z.md` を作る
5. もう一度 `npm test` を実行する（ヘルプの記事の検証を含む）

### 7. コミットする

```bash
git add package.json package-lock.json packages/*/package.json README.md CHANGELOG.md docs/help/updates-vX-Y-Z.md <手順 5 で直したファイル>
git commit -m "$(cat <<'MSG'
release: Version X.Y.Z — <CHANGELOG と同じ日本語の概要>

<必要なら 1〜3 行の補足（配備で行うことの要約など）>

Co-Authored-By: <セッションの指示にある共著者の行>
MSG
)"
```

- 1 行目は必ず `release: Version X.Y.Z — <概要>` の形式にする（検索できるようにするため）
- 共著者の行は、そのセッションで指示されたもの（`Co-Authored-By: Claude … <noreply@anthropic.com>`）をそのまま使う。モデル名を決め打ちしない
- `--no-verify` でフックを飛ばさない。フックが失敗したら原因を直し、新しいコミットとしてやり直す（`--amend` はしない）

### 8. 注釈付きタグを作る

```bash
git tag -a vX.Y.Z -m "Version X.Y.Z — <CHANGELOG と同じ日本語の概要>"
```

### 9. 生成物を作り直す

リリースの時点の内容で、配布用の PDF を作り直す（どちらも版管理の対象外。コミットには含めない）。
`<scratchpad>` はセッションの一時ディレクトリ。

```bash
npm run docs:manual-pdf     # 開発者マニュアル → docs/developer/developer-manual.pdf
python3 tools/pdf/build.py specification.md <scratchpad>/specification.html
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --no-sandbox \
  --no-pdf-header-footer --run-all-compositor-stages-before-draw --virtual-time-budget=25000 \
  --print-to-pdf=specification.pdf "file://<scratchpad>/specification.html"
pdftotext -f 1 -l 1 specification.pdf - | grep draft    # 表紙の版が仕様書の版と合うか
```

画面は、いまのところ版の番号をビルドに埋め込んでいない。**埋め込むようにした後は、リリースのコミットの後に必ず
`npm run build -w packages/web` で作り直し、埋め込まれた値を確かめること**
（AI Radio で、作り直しを省いて画面の版が古いまま残った事故がある）。

### 10. 結果を確かめて報告する

```bash
git log --oneline -1
git tag --list | tail -5
git status --short     # 残った変更が無いか
```

次を報告する。
- コミットのハッシュとタグの名前
- 手順 3 の確認の結果（通ったもの・未確認のもの）
- 配備で行うこと（移行・環境変数・再同意）
- 作り直した PDF

**この時点ではリモートに push しない。** push するかは必ず尋ねる。
開発サーバーの再起動が要る変更（移行の追加など）があれば、その旨を伝え、再起動するかは確かめてから行う。

## やってはいけないこと

- コミット・タグを作る前に、内容を確かめずに進めること
- `git add -A` / `git add .` で無関係な変更まで巻き込むこと
- `.gitignore` の対象（`.env`・`.data/`・`specification.pdf`・`developer-manual.pdf`・ログ）をコミットに含めること
- ワークスペースのうち一部の `package.json` だけ版を上げること（全部そろえる）
- 仕様書・スキーマ・公開 API・拡張機能・規約の版を、サービス本体の版に合わせて上げること
- テスト・型・ビルドのどれかが失敗したまま、コミット・タグを作ること
- 確かめていない事前確認の項目を「確認済み」と書くこと
- 開発者向けの文章を、利用者向けの記事にそのまま使うこと（またはその逆）
- `npm version` を `--no-git-tag-version` なしで実行すること
- 確認なしに `git push` すること
- 確認なしに開発サーバーを起動・再起動すること
