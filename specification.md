---
title: M2Office 仕様書
version: 0.330.0
status: draft
created: 2026-09-20
updated: 2026-10-01
owner: 三浦
tags: [M2Office, specification, ai-agent, sme, saas, platform, google-workspace, gemini, secretary-agent]
---

# M2Office 仕様書

> 本書は M2Office の単一の正となる仕様書（Single Source of Truth）です。
> 全 9 部・26 章で構成し、検討が進むたびに各章を更新していきます。
> 未確定事項は `TBD` と明記し、第26章「未決事項」に一覧化します。

## 0. 文書管理

### 0.1 本書の構成

全体を 10 の部に分けている。**通しで読む必要はない。**

**本書は章ごとのファイルに分けて持つ**（第 0.139.0 版、ADR-0041）。このファイル（`specification.md`）は入口で、
版・文書管理（第0章）と、読む順番を持つ。各章は `spec/` の下の 1 ファイルにある。章と節の番号は分ける前と変えない。

| 部 | 章 | 内容 | ファイル |
|---|---|---|---|
| I 背景と位置づけ | 1〜3 | なぜ作るのか。市場のどこに空白があるか | [01](spec/01-background.md)・[02](spec/02-overview.md)・[03](spec/03-terms.md) |
| II 利用者から見た姿 | 4〜7 | 誰が、何を、どの画面で行うか | [04](spec/04-stakeholders.md)・[05](spec/05-use-cases.md)・[06](spec/06-ux.md)・[07](spec/07-functional-requirements.md) |
| III 中核の仕組み | 8〜11 | エージェントがどう動き、知識がどう貯まるか | [08](spec/08-architecture.md)・[09](spec/09-agent-platform.md)・[10](spec/10-secretary.md)・[11](spec/11-knowledge.md) |
| IV 拡張とエコシステム | 12〜13 | 提供側だけで作らないための仕組み | [12](spec/12-extensions.md)・[13](spec/13-platform-api.md) |
| V 連携と制度 | 14〜15 | 外部と何をつなぎ、日本の制度にどう合わせるか | [14](spec/14-google.md)・[15](spec/15-localization.md) |
| VI 安全性と品質 | 16〜18 | 組織で使うために守ること | [16](spec/16-security.md)・[17](spec/17-non-functional.md)・[18](spec/18-quality.md) |
| VII 実装 | 19〜20 | 何をどう作るか | [19](spec/19-data-model.md)・[20](spec/20-tech-stack.md) |
| VIII 事業と運用 | 21〜23 | どう売り、どう運ぶか | [21](spec/21-business-model.md)・[22](spec/22-operations.md)・[23](spec/23-backyard.md) |
| IX 計画 | 24〜26 | これからどう進めるか | [24](spec/24-roadmap.md)・[25](spec/25-risks.md)・[26](spec/26-open-questions.md) |
| X 業務の拡張 | 27〜 | 中小企業が共通して使う業務を、拡張として 1 つずつ定める（第 0.139.0 版） | [27 名刺管理](spec/27-business-cards.md)・[28 契約書チェック](spec/28-contract-review.md)・[29 在庫管理](spec/29-inventory.md)（案）・[30 人事・給与](spec/30-hr-payroll.md)（案）・[31 店頭サイネージ](spec/31-signage.md)（案）・[32 Web のコラム](spec/32-web-columns.md)（案）・[33 問い合わせの記録](spec/33-inquiries.md)（案）・[34 Webの分析](spec/34-web-review.md)（案）・[35 お知らせの作成](spec/35-announcements.md)（案）・[36 競合の分析](spec/36-competitors.md)（案）・[37 会議室・社用車・備品の予約](spec/37-reservations.md)・[38 契約の管理](spec/38-contracts.md)・[39 補助金・助成金の案内](spec/39-subsidies.md)・[40 会員とポイント](spec/40-members.md)・[41 販促物の作成](spec/41-print-designs.md) |
| 付録 | A〜D | 更新方針・参考資料・出典・改訂履歴 | [A](spec/appendix-a-update-policy.md)・[B](spec/appendix-b-references.md)・[C](spec/appendix-c-data-sources.md)・[D](spec/appendix-d-history.md) |

### 0.2 どこから読むか

| 立場 | 読む順序 |
|---|---|
| 全体像を知りたい | 第1章 → 第2章 → 第26章（未決事項） |
| 開発に参加する | 第II部 → 第III部 → 第VII部 → 第24.3節（プロトタイプ） |
| 事業として検討する | 第I部 → 第VIII部 → 第IX部 |
| 拡張を作る | 第9.2節（定義スキーマ）→ 第IV部 |
| 安全性を確認する | 第8.3節（不変則）→ 第VI部 |
| 画面を確認する | 第6.1節（ワークスペース）→ 第6.5節（個人設定）→ 第6.6節（管理者ページ）→ 第6.7節（ダッシュボード）→ 第6.10節（ヘルプ） |
| 運営を設計する | 第23章（運営バックヤード。第23.8節がマスター管理画面） |
| いま何ができているかを知る | 第24.4節（現在の実装状況） |

**急ぐ場合は、第1.3節（事業機会）と第2.3節（共通基盤と拡張）の 2 節だけで骨子が分かる。**

### 0.3 記述の約束

| # | 約束 |
|---|---|
| 1 | 各章・各節の冒頭に「この章（節）で決めること」を記載する |
| 2 | 確定事項は断定形、検討中の事項は `TBD:` を先頭に付ける |
| 3 | 実装が本書と乖離した場合は、実装ではなく本書を先に更新する |
| 4 | 大きな設計判断は本書に結論のみ記し、理由は ADR に残す |
| 5 | **改訂の記録は付録 D に置く**。本文を読む妨げにしないため |
| 6 | **1 章を 1 ファイルにする**（`spec/NN-名前.md`）。章を足すときはファイルを足し、末尾の読む順番に 1 行足す。章と節の番号はファイルの名前に依らず、本書を通して一意にする（ADR-0041） |
| 7 | **中小企業が共通して使う業務の拡張は、第 X 部に 1 章ずつ足す**。後から足す拡張で、既存の章の番号をずらさない |

### 0.4 運営主体

本サービスを運営し、責任を負う法人（運営主体）は、**サーバーに配備したときにマスター管理画面で設定する**（第23.8.14節）。仕様書・コード・資料には法人名を書かず、設定するまでは空欄にする（2026-09-30 に決定。Q-138）。

| 項目 | 内容 |
|---|---|
| 会社名 |  |
| 所在地 |  |
| Web |  |

本書で「M2Office 運営」と記す場合は同社を指す。
第23章の運営バックヤードは、同社が M2Office を運営するための仕組みである。

**規約と契約書に要る項目は、本書では一覧だけを定める**（Q-42 で決定）。
会社の個別の値は、規約を作るときに埋める。本書に値を持たせない（更新が二重になるため）。

| 要る項目 | 使う場所 |
|---|---|
| 会社名・所在地・Web | 規約、特定商取引法に基づく表記、帳票 |
| 設立年・資本金 | 契約書、与信の確認 |
| 代表者名 | 規約、契約書 |
| 連絡先（問い合わせの窓口） | 規約、ヘルプの問い合わせ（第6.10.11節） |
| 適格請求書発行事業者の登録番号 | 請求書（第23.4節） |
| 個人情報の取り扱いの窓口 | プライバシーポリシー（第11.9.4節） |

### 0.5 関連文書

| 文書 | 位置付け | 所在 |
|---|---|---|
| specification.md | 本書の入口。版・文書管理・読む順番。全体仕様の正は、これと `spec/` の各章を合わせたもの | 本ファイル、`spec/` |
| CLAUDE.md | 開発エージェント向け作業規約。要点と参照先 | `CLAUDE.md` |
| 開発規約 | コードの書き方、JSDoc、README の規定 | `docs/coding-standards.md` |
| リリース規定 | バージョンの付け方、リリース手順、リリースノート | `docs/release-process.md` |
| ADR（設計判断記録） | 重要な技術選定の根拠 | `docs/adr/` |
| **開発者マニュアル** | 拡張機能（業務エージェント・コネクタ）の作り方、定義のリファレンス、サンプル | `docs/developer/` |
| ADR-0001 | 画面を SPA として実装する判断 | `docs/adr/0001-frontend-spa.md` |
| ADR-0002 | API フレームワークに Hono を採用する判断 | `docs/adr/0002-api-framework-hono.md` |
| ADR-0003 | 外部接続の手前に接続口を設け、未接続の間はダミーで骨格を作る判断 | `docs/adr/0003-connector-and-dev-scaffold.md` |
| ADR-0004 | 文書形式を扱うライブラリの選定 | `docs/adr/0004-document-format-libraries.md` |
| ADR-0005 | 持ち運べる拡張機能の保存と、MCP サーバへの接続の方式 | `docs/adr/0005-portable-extensions-and-mcp-client.md` |
| ADR-0006 | 調査とスライドの作成を AI Radio から移植する判断 | `docs/adr/0006-research-and-slides-from-ai-radio.md` |
| ADR-0007 | 接続の設定（会社の OAuth クライアント、秘密の値の暗号化、Gemini Live の中継） | `docs/adr/0007-connection-settings.md` |
| ADR-0008 | 組織知識の検索（節への分割、点数による並べ替え、ベクトル検索は後から） | `docs/adr/0008-knowledge-search.md` |
| ADR-0009 | 意味的検索（pgvector での厳密な検索、順位の融合、Gemini の埋め込み） | `docs/adr/0009-semantic-search.md` |
| ADR-0010 | 議事録の組織知識への登録（承認②に含め、承認した成果物だけを登録する） | `docs/adr/0010-minutes-to-knowledge.md` |
| ADR-0011 | 通知を Chat へ届ける方式（控えとして題名とリンクだけを送る） | `docs/adr/0011-notification-delivery.md` |
| ADR-0012 | 個人記憶は、本人が頼んだときだけ覚える（Phase 1） | `docs/adr/0012-personal-memory-explicit.md` |
| ADR-0013 | ダッシュボードの人の状態と、SSE による更新の方式 | `docs/adr/0013-dashboard-presence-sse.md` |
| ADR-0014 | 会話ログの持ち方（1 往復を 1 件、本人だけ、4 週で消す） | `docs/adr/0014-conversation-log.md` |
| ADR-0015 | 対話からの学習は、候補を示して本人が採る | `docs/adr/0015-memory-candidates.md` |
| ADR-0016 | 昇華の実装（二重の承認、承認者の範囲、登録の形） | `docs/adr/0016-memory-promotion.md` |
| ADR-0017 | 帳票の PDF の書体と、OCR の実現方式 | `docs/adr/0017-pdf-font-and-ocr.md` |
| ADR-0018 | 音声の対話の接続口と、中継の作り | `docs/adr/0018-voice-session.md` |
| ADR-0019 | 外部公開する API のパスの体系（実装を正とする） | `docs/adr/0019-api-path-scheme.md` |
| ADR-0020 | 画面右の領域を、秘書との会話専用にする | `docs/adr/0020-conversation-pane.md` |
| ADR-0021 | キーボードの割り当ては、自前の薄い層で持つ | `docs/adr/0021-keyboard-shortcuts.md` |
| ADR-0022 | Google の接続口は Gmail とカレンダーから本物にし、残りは見本で代えずに断る | `docs/adr/0022-google-connector-first-slice.md` |
| ADR-0023 | 承認の直後の段を承認の前に組み立て、承認されたら記録した操作をそのまま実行する | `docs/adr/0023-plan-before-approval.md` |
| ADR-0024 | 承認の前に、記録する操作が行えるかを確かめる（行えないものは記録せず、理由を承認の画面に出す） | `docs/adr/0024-check-before-approval.md` |
| ADR-0025 | 議事録を Google ドキュメントにも保存し、承認②のあとに会社の全員が閲覧できるようにする | `docs/adr/0025-minutes-to-google-docs.md` |
| ADR-0026 | 画面右を、会話の履歴から「秘書のキャンバス」（結果を見せる場所）に改め、文字の依頼は文字で・音声の依頼は音声で返す | `docs/adr/0026-secretary-canvas.md` |
| ADR-0027 | 秘書は対話から学び続け、そのまま覚える（本人はいつでも見て直せる）。答えるたびに長期の記憶を使う | `docs/adr/0027-continuous-learning.md` |
| ADR-0028 | 人に判断を求めるのは、社外に出るものとお金の確定だけにする。ほかは秘書と業務が自分で決める（学習・訂正・会社の知識にする判断を含む） | `docs/adr/0028-ai-decides-by-default.md` |
| ADR-0030 | 推論（Gemini）が無い環境を想定しない。見本の応答は自動テストの中だけで使う | `docs/adr/0030-no-keyless-environment.md` |
| ADR-0031 | Google スライドは、テンプレートのファイルを使わずに標準の見た目で組み立てる | `docs/adr/0031-slides-standard-look.md` |
| ADR-0032 | 会社のスライドのテンプレートを使うために、ドライブ全体の権限を求める | `docs/adr/0032-drive-scope-for-slide-templates.md` |
| ADR-0033 | 秘書はあらゆる依頼に応え、専門の業務は頼んで実行して報告する | `docs/adr/0033-secretary-answers-everything.md` |
| ADR-0034 | 秘書が先回りする最初の一歩として、朝のブリーフを本人ごとに自動で用意する | `docs/adr/0034-morning-brief.md` |
| ADR-0035 | Google Workspace だけでできる基本の業務を、公式に揃える | `docs/adr/0035-basic-workspace-agents.md` |
| ADR-0036 | 秘書が予定と会話を見て先回りする（会議の直前・前日の移動・「あとで」の ToDo） | `docs/adr/0036-secretary-proactive.md` |
| ADR-0037 | コネクタ（MCP）を拡張機能から切り離し、会社の接続として一元管理する | `docs/adr/0037-connections-as-company-resource.md` |
| ADR-0038 | 秘書は、本人が直接使った業務の結果からも学ぶ | `docs/adr/0038-secretary-learns-from-work.md` |
| ADR-0039 | 業務と秘書をイベントでつなぎ、秘書が指揮者になる | `docs/adr/0039-secretary-conducts-by-events.md` |
| ADR-0040 | 秘書が段取りをし、分身に任せて会話を続ける | `docs/adr/0040-secretary-plans-with-sub-agent.md` |
| ADR-0029 | 業務エージェントは「スキルの形式（SKILL.md）＋α」で書く。段と承認は取り込むときに組み立てる | `docs/adr/0029-skill-format-extensions.md` |
| ADR-0041 | 仕様書を章ごとのファイルに分け、入口の `specification.md` に読む順番を持つ | `docs/adr/0041-split-specification.md` |
| ADR-0042 | 名刺管理を、データの置き場と画面を持つ「内蔵の拡張」として中核に組み込む | `docs/adr/0042-business-cards-built-in.md` |
| ADR-0043 | 契約書チェックを公式の拡張機能（スキル）として作り、論点の提示にとどめる | `docs/adr/0043-contract-review-extension.md` |
| ADR-0044 | 認証の要る接続は、会社がアプリを登録し利用者ごとに認可する形を基本にし、最初に Slack で確かめる | `docs/adr/0044-authenticated-connections.md` |
| ADR-0045 | 在庫管理を、既定で切りの汎用の「内蔵の拡張」として作る | `docs/adr/0045-inventory-built-in.md` |
| ADR-0046 | 医療機関の診療データの分析は M2Office に組み込まず、別のシステムにして集計だけをつなぐ | `docs/adr/0046-clinic-data-analysis-separate-system.md` |
| ADR-0047 | 朝のブリーフの中身を人ごとにし、社内のお知らせを流す | `docs/adr/0047-brief-per-person-and-notices.md` |
| ADR-0048 | 週次ブリーフを「今週の見通しと先週からの変化」にし、全員に自動で用意する | `docs/adr/0048-weekly-brief-outlook.md` |
| ADR-0049 | 人事・給与を M2Office の中で完結させる（給与計算を内製する） | `docs/adr/0049-hr-payroll-built-in.md` |
| ADR-0050 | 在庫管理のバーコードの読み取りと棚のラベルに使う部品 | `docs/adr/0050-inventory-barcode-and-label-libraries.md` |
| ADR-0051 | 店頭サイネージを内蔵の拡張にし、会社の画面に出すことを社外への送信としない | `docs/adr/0051-signage-own-screens-not-external.md` |
| ADR-0052 | 源泉所得税は税額表で引き、法令の表は公式の発表から取り込んだデータのファイルとして持つ | `docs/adr/0052-payroll-law-tables-as-data.md` |
| ADR-0053 | 給与の確定は管理者が給与の画面で押すことを承認とし、監修前の表での確定は開発の環境だけに許す | `docs/adr/0053-payroll-confirm-by-admin.md` |
| ADR-0054 | 人事・給与の責任の範囲（規約）と、記録の保存の期間・消し方 | `docs/adr/0054-payroll-liability-and-retention.md` |
| ADR-0055 | 従業員の顔写真（取り込み方・見られる人・残す期間） | `docs/adr/0055-employee-photos.md` |
| 実地の確認の手順 | 自社で使いながら確かめる順番と、用意するもの | `docs/acceptance-test.md` |
| プラットフォーム API リファレンス | 公開 API の仕様 | TBD: 実装から自動生成 |

---

<!--
  読む順番（1 行に 1 ファイル）。tools/pdf/build.py がこの順につないで 1 冊にする。
  章を足したら、ここに 1 行足す（第0.3節 約束 6）。
-->
<!-- include: spec/01-background.md -->
<!-- include: spec/02-overview.md -->
<!-- include: spec/03-terms.md -->
<!-- include: spec/04-stakeholders.md -->
<!-- include: spec/05-use-cases.md -->
<!-- include: spec/06-ux.md -->
<!-- include: spec/07-functional-requirements.md -->
<!-- include: spec/08-architecture.md -->
<!-- include: spec/09-agent-platform.md -->
<!-- include: spec/10-secretary.md -->
<!-- include: spec/11-knowledge.md -->
<!-- include: spec/12-extensions.md -->
<!-- include: spec/13-platform-api.md -->
<!-- include: spec/14-google.md -->
<!-- include: spec/15-localization.md -->
<!-- include: spec/16-security.md -->
<!-- include: spec/17-non-functional.md -->
<!-- include: spec/18-quality.md -->
<!-- include: spec/19-data-model.md -->
<!-- include: spec/20-tech-stack.md -->
<!-- include: spec/21-business-model.md -->
<!-- include: spec/22-operations.md -->
<!-- include: spec/23-backyard.md -->
<!-- include: spec/24-roadmap.md -->
<!-- include: spec/25-risks.md -->
<!-- include: spec/26-open-questions.md -->
<!-- include: spec/27-business-cards.md -->
<!-- include: spec/28-contract-review.md -->
<!-- include: spec/29-inventory.md -->
<!-- include: spec/30-hr-payroll.md -->
<!-- include: spec/31-signage.md -->
<!-- include: spec/32-web-columns.md -->
<!-- include: spec/appendix-a-update-policy.md -->
<!-- include: spec/appendix-b-references.md -->
<!-- include: spec/appendix-c-data-sources.md -->
<!-- include: spec/appendix-d-history.md -->
