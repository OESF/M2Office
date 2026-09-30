## 第 VII 部　実装

何をどう作るか。

## 19. データモデル

### 19.1 主要エンティティ

| エンティティ | 概要 | 主な属性 |
|---|---|---|
| tenant | 契約企業 | サブドメイン、Workspace ドメイン、プラン、状態（`trial`・`active`・`suspended`・`locked`・`cancelled`。第23.8.6節） |
| user | 利用者 | tenant_id、Google アカウント識別子、メールアドレス、氏名、状態 |
| persona | ペルソナ | user_id、役割、権限範囲、応対スタイル、音声設定 |
| google_link | Google 連携 | user_id、認可済みスコープ、トークン（暗号化）、状態 |
| extension | 拡張機能 | 提供者、版、区分、マニフェスト |
| tenant_extension | 導入状態 | tenant_id、extension_id、版、同意した権限、有効／無効 |
| agent_definition | エージェント定義 | extension_id、id、version、定義本体（JSON） |
| tenant_agent | テナントでの有効化 | tenant_id、agent 参照、設定の上書き、権限割当 |
| job | 依頼 | tenant_id、agent 参照、依頼者、入力、起動経路、状態 |
| run | 実行 | job_id、状態、時刻、消費トークン、費用、削減時間推計 |
| run_step | ステップ | run_id、順序、種別、入力、出力、状態、所要時間 |
| approval | 承認 | run_step_id、承認できるロール、**判断できる利用者（依頼者本人の承認の場合）**、判断、コメント、日時 |
| compartment | 権限区画 | tenant_id、名称、説明、有効／無効 |
| compartment_member | 区画の個人の割当 | compartment_id、user_id、割当者、割当日時 |
| compartment_group | 区画のグループの割当 | tenant_id、compartment_id、group_id、割当者、割当日時（第16.7.5節） |
| user_group | グループ | tenant_id、名前、説明（第16.7節） |
| user_group_member | グループの所属 | tenant_id、group_id、user_id |
| **memory_personal** | 個人記憶 | user_id、種別、内容、出典、確信度、最終更新、**区画除外の印** |
| **memory_team** | チーム記憶 | team_id、内容、出典、昇華元 |
| **knowledge_item** | 組織知識 | tenant_id、種別、内容、出典、版、公開範囲、登録者、**区画**、登録した実行・Google から読んだデータで作ったか（業務から登録したもの。第9.5.2節） |
| knowledge_section | 組織知識の節（検索と出典の単位） | tenant_id、knowledge_item の参照、順序、見出し、見出しの経路、本文（第11.7.2節）。Phase 2 で、本文のハッシュ・埋め込み・埋め込みのモデルと次元・作った日時（第11.7.6.1節） |
| **promotion** | 昇華 | 元記憶、本人承認、組織承認、状態、日時 |
| knowledge_source | 知識の取込元 | tenant_id、種別、対象パス、同期状態、**区画** |
| conversation | 秘書との対話 | user_id、文脈、開始・終了、入力経路（音声／テキスト） |
| conversation_turn | 発話単位 | conversation_id、入力、出力、参照した記憶、評価（承認／修正／却下）、学習除外フラグ、**区画の印** |
| connector | 外部接続 | tenant_id、種別、認証情報（暗号化）、有効ツール、状態 |
| connection_secret | 会社の接続の認証情報（第12.11.6節） | tenant_id、接続の ID、クライアント ID、シークレット（暗号化）または会社の鍵（暗号化）と見出しの名前、認可の口、求める権限 |
| user_connection | 利用者ごとの接続の認可（第12.11.6.3節） | tenant_id、user_id、接続の ID、認可（暗号化）、更新用の認可（暗号化）、期限、許可された権限、許可したアカウントの表示名、接続した日時 |
| llm_config | LLM 設定 | tenant_id、プロバイダ、モデル階層、認証情報（暗号化）、上限 |
| api_client | 外部アプリ | tenant_id、名称、スコープ、最大危険度、状態 |
| artifact | 成果物 | run_id、種別、保存先、確定状態、ファイルの参照 |
| file | ファイル | tenant_id、所有者、名前、形式、大きさ、SHA-256、出どころ（受け取り／業務が作成／名刺。名刺は第 0.139.0 版）、run_id |
| contact | 連絡先（名刺管理。第27.11節） | tenant_id、範囲（会社で共有／自分だけ）、持ち主、氏名、ふりがな、会社名、部署、役職、連絡先の項目、メモ、まとめた先、状態、作った人・直した人と日時 |
| contact_card | 名刺（第27.11節） | tenant_id、contact_id、表と裏の画像（file）、読み取り結果、人が直した項目、受け取った人、受け取った日 |
| inventory_item・inventory_code | 在庫の品目とバーコード（第29.19節。案） | tenant_id、名前、自社のコード、単位、分類、写真、発注点、状態。バーコードは品目にいくつでも、会社の中で重ならない |
| inventory_location・inventory_lot・inventory_stock | 在庫の場所・ロット・いまの数（第29.19節。案） | 倉庫と棚、棚のラベル。ロットと使用期限。場所・ロットごとの品目の数（入出庫の記録から求める） |
| inventory_move | 入出庫の記録（第29.19節。案） | 種類（入庫・出庫・移動・調整）、品目、場所、数、理由、元になったもの、記録した人と日時。**追記のみ** |
| inventory_count・inventory_count_line | 棚卸しと、その行（第29.19節。案） | 対象・状態・始めた人と確定した人。行は品目・場所・数えた数・数えた時点の帳簿の数・数えた人 |
| inventory_reservation・inventory_publication | 引き当てと公開（第29.19節。案） | 予約の番号と日時・品目・数・状態（**予約した人の情報を持たない**）。公開は承認した品目と項目・承認した人・公開の URL の鍵・状態 |
| signage_screen・signage_screen_presence・signage_pairing・signage_asset・signage_entry・signage_interrupt・signage_interrupt_target・signage_phrase・signage_source・signage_sound | 店頭サイネージ（第31.15節。案） | 画面（1 社 3 台まで。鍵のハッシュ・向き・回し方・流れの版・最後に通信した時刻）・ふだん動いている時間帯・登録を待つ番号・素材（画像・動画・HTML。中身は会社のファイルの置き場で、`files` の表には入れない）・流れ・割り込みと出す先（**文は出し終えて 24 時間で消す**。行は 90 日）・よく出す案内・呼び出しの受け口・会社のジングルの音 |
| hr_*・att_*・leave_*・pay_*・yea_* | 人事・給与（第30.24節。案） | 従業員・雇用条件（履歴）・社会保険・標準報酬月額（履歴）・税・住民税・家族・口座・通勤・マイナンバー（暗号化・別の区画）・打刻と勤怠・休暇・給与の設定と項目・給与の回と明細（行ごとの根拠）・振込データ・年末調整・届出の下書き |
| law_table | 法令の表（第23.8.13節。案） | **テナントを持たない運営の表**。種類・範囲・施行日・値・出典と確認日 |
| schedule | 定時実行 | tenant_id、対象者、agent 参照、入力、規則（毎日／毎平日／毎週。毎平日は第 0.125.0 版）、タイムゾーン、次回・前回の時刻、有効／無効 |
| notification | 本人宛の通知 | tenant_id、宛先の利用者（1 人）、種類、題名、本文、run_id、既読の日時 |
| notice・notice_receipt | 社内のお知らせと、受け取った人ごとの状態（第10.15節。第 0.152.0 版） | tenant_id、出した人、題名、本文、リンク、宛先（全員かグループ）、締切、載せる最後の日、取り下げた人と日時。受け取った人ごとに、初めてブリーフに載せた日時と済んだ日時 |
| session | ログイン状態 | tenant_id、user_id、Cookie の値のハッシュ、CSRF トークン、手段、端末、期限、失効の日時 |
| tenant_settings | 会社の設定 | tenant_id、会社情報、自社の書き方、自動化ポリシー、業務の有効化、効果の推計、知識の言い換え（第11.7.7節） |
| user_settings | 個人設定 | tenant_id、user_id、プロフィール、秘書、通知、メニューの並び、朝のブリーフの中身（関心の分野・外した項目。第9.5.5.1.1節） |
| audit_event | 監査イベント | tenant_id、主体、操作、対象、根拠、日時 |
| usage_record | 利用実績 | tenant_id、期間、シート数、トークン、実行件数 |

### 19.2 テナント分離

全テーブルに `tenant_id` を持たせ、PostgreSQL の行レベルセキュリティ（RLS）で
アプリケーションの不具合があってもテナントを越えられないようにする。

個人記憶にはさらに `user_id` による絞り込みを適用し、
**同一テナント内でも他者の個人記憶を参照できない**ことを保証する（不変則 I-10）。

### 19.3 データ保持と削除

| 対象 | 保持期間 | 備考 |
|---|---|---|
| 秘書に渡したファイル | **4 週間**（第10.10.5節）。会話ログと寿命をそろえる。業務に渡したものは、その実行の成果物として 1 年 |
| 実行履歴・成果物 | **1 年**（Q-11 で決定）。プランによる延長は Phase 2 | Google から取得した中身とそこから作った文は、実行が終わってから 7 日で消し、目印だけを残す（第14.3.2節、Q-78） |
| 監査ログ | 3 年以上。ローテーションしない（第11.9.6節） | 電帳法・内部統制の観点。TBD: 上限の年数 |
| システムログ | 4 週（週次ローテーション） | 第11.9.6節、開発規約 第7.6節 |
| 個人記憶 | 在籍中は保持、退職時に削除 | 第11.6節 |
| 組織知識 | 会社の資産として保持 | 版管理を行う。Google から読んだデータで作った議事録も含む（第9.5.2節） |
| 会話ログ（逐語） | 4 週（週次ローテーション） | 第11.9.6節 |
| 会話の要約・学習用データ | 長期 | 第11.9.6節 |
| 解約時 | **解約後 30 日は閲覧と持ち出しができ、その後に削除する**（Q-11 で決定） | 契約面の猶予（試用期間・停止までの猶予）は Q-29 |
| 人事・給与の記録 | **7 年**（年ごとの記録は年の終わり、従業員の台帳は退職の日から。Q-134・ADR-0054） | 過ぎたら自動で消す（30 日前に知らせ、書き出せる）。解約のときは法定の帳簿をまとめて書き出して渡し、解約後 30 日で消す（まとめての書き出しは第 0.182.0 版。自動で消す仕組みは後の段） |
| 店頭サイネージの割り込みの文 | **出し終えて 24 時間**（第31.13節。Q-148） | 番号や名前が入りうるため。出し終えた後の使い道が無く、来店・来院の記録を溜めないため。秘書に頼んだ会話の記録は会話ログの決まりのまま |
| 店頭サイネージの割り込みの行 | **90 日**（第31.7.2節） | 文と番号を消した後の、種類・出す先・状態・時刻だけ |
| 店頭サイネージのふだん動いている時間帯・登録を待つ番号 | 14 日・10 分（第31.5.1節） | |

### 19.4 現在の実装との対応

第 0.33.0 版時点でデータベースにある表と、第19.1節のエンティティの対応。
**無い表は、まだ実装していない**（個人記憶・会話・コネクタの認証情報・LLM 設定など）。

| 表 | エンティティ | 分離の方式 |
|---|---|---|
| `tenants` | tenant | テナント台帳。アプリは参照のみ |
| `users`・`compartments`・`jobs`・`runs`・`approvals`・`artifacts`・`knowledge_items`・`audit_events`・`schedules`・`notifications`・`sessions`・`files`・`tenant_settings`・`user_settings` | 同名のエンティティ | `tenant_id` による RLS（第8.5.5節） |
| `run_steps`・`compartment_members` | run_step・compartment_member | 親の表（`runs`・`compartments`）を通じた RLS |
| `tenant_extensions` | installation（導入と同意した権限、有効・無効） | `tenant_id` による RLS |
| `tenant_extension_packages` | extension（ファイルから取り込んだ自社専用のもの。第12.10.6節） | `tenant_id` による RLS |
| `user_groups`・`user_group_members` | user_group・user_group_member（第16.7節） | `tenant_id` による RLS |
| `compartment_groups` | compartment_group（第16.7.5節） | `tenant_id` による RLS |
| `knowledge_sections` | knowledge_section（第11.7.2節） | `tenant_id` による RLS |

`audit_events` はアプリのロールに更新・削除の権限を与えず、追記のみとしている。

---

