# @m2office/core

ドメインロジック。実行エンジン、承認、ツール、秘書、LLM 抽象化層を持ちます。

**HTTP・フレームワーク・画面に依存しません。**
API とワーカーの双方から同じロジックを呼べるようにするためです（仕様書 第20.5節）。

## 前提

Node.js 22 以上。PostgreSQL への接続が必要です（`DATABASE_URL`）。

## 構成

```
src/engine/      実行エンジン。承認による中断と再開、ジョブの投入
src/tools/       ツールの登録簿と内蔵ツール
src/connectors/  メール・予定・タスク・チャット・本人の Google の連絡先（google/people.ts。第27.15節）への接続口（見本と Google の実装）と、MCP サーバのクライアント。認証の要る会社の接続の許可の流れとアプリの自動登録（oauth.ts。動的クライアント登録）・登録の型（presets.ts。Slack）・呼ぶときの認可（credentials.ts。仕様書 第12.11.6節）
src/chat/        グループの名前で共有する（group-share.ts。グループに合う Chat のスペースを探す・承認の画面に届く先とグループとの違いを出す。仕様書 第16.7.12.1節、ADR-0076）
src/files/       ファイルの置き場と、PDF・Excel・CSV・Word の読み書き。
                 to-text.ts は形式によらず「読むための文字」にし、指示ではないものとして囲う（第10.10節）。
                 compare.ts は 2 つの版を条項ごとに比べる（ツール file.compare。契約書の修正版との差分。第28.13節）。
                 redline.ts は修正の案を Word の変更履歴とコメントとして入れる（ツール docx.redline。第28.15節）。
                 長い文書は to-text.ts の splitParts・outlineOf で部分に分け、条の見出しの一覧を返す（file.read_text の part）。
                 font-chars.ts は、同梱の書体に無い JIS の正式な対応の字（マイナス記号など）を、描く前に同じ形の字に置き換える
src/log/         アプリログのロガー（レベル・JSON・伏せ字）
src/help/        ヘルプ（業務の説明の自動生成、記事の出し分けと検索、答えられなかった質問と役に立ったかの置き場 feedback.ts。第6.10.10節。会社の補足の置き場 notes.ts・補足の案 suggest.ts。第6.10.7節）
src/knowledge/   組織知識の節への分割（章・条・見出し）と、検索の言葉の取り出し・並べ替え（社内規程 → 議事録 → 秘書が学んだことの順）、
                 意味での検索（embed.ts。節を後から埋め込む見回り KnowledgeEmbedder・質問を埋め込む queryEmbedder・本番での入り切り。
                 言葉の検索との順位の融合は search.ts の fuseRankings。第11.7.6節）、
                 秘書が学んだことと各人の記憶の週 1 回の整理と、残す期間の片付け（consolidate.ts。第11.11節）
src/extensions/  拡張機能の読み込みと検証、.m2ext の作成と展開、コネクタの宣言、会社ごとの見え方
src/scheduler/   定時実行の規則と起動役、画面と秘書で共通の操作の決まり（登録できる業務・必須の入力・再開・今すぐ実行）、次の回に動かない理由の判定（blocker.ts。起動役と管理者の一覧が共有）
src/notify/      通知の控え（Chat）の送信口と、届ける見回り役
src/health/      接続先の健全性（呼び出しの成否と時間だけを 1 分単位で貯める受け口・置き場・状態の決め方・推論の包み。第6.7.6節、移行 086）
src/retention/   Google から取得したデータの保持（期間を過ぎた実行の中身を消す、承認待ちの期限切れ）と、許可がなくなったときの業務の後始末
src/llm/         LLM 抽象化層（OpenAI 互換、設定されていない会社の推論、自動テスト用のスタブ、ローカル AI の口 local.ts、
                 配備の形と会社の AI の方針から使う AI を決める policy.ts。仕様書 第8.6節・第16.3.7.1節）。
                 models.ts は役割ごとの既定のモデルと、モデルごとの値段の表（出どころと確認日つき。第20.2.2節）
                 gemini.ts は一時的な失敗（混雑・障害・届かない・モデルが無い）のとき、同じ鍵のまま設定にあるほかのモデルへ退避する（3 回まで。第20.2.5節）。
                 動画（Veo）は作業を頼み、できるまで見に行き、鍵を付けて受け取る（延長に失敗したら最初の 8 秒を返す。第32.18.6節）
src/repository/  永続化。テナント境界の絞り込みを伴う。接続の置き場は必ず pool.ts の createPool で作る（切れた接続の error を受け止め、警告を残してつなぎ直す。new pg.Pool を直接書かない）
src/agents/      公式エージェントの定義（AG-01〜05）
src/announcements/ お知らせの作成（内蔵の拡張。第35章の段 1・段 2）。置き場（store.ts。休業の期間も）、下書き（draft.ts。推論と期間の読み方）、
                 サイネージの画面の 1 枚（screen-image.ts）、メール（mail.ts。宛先の案と、名刺管理のまとめてのメールで送る口）、
                 宛先を言葉で絞る（recipients.ts。頼みを条件にし、当てはめは推論を使わない）、
                 処理（service.ts。直す・承認の前の確かめ・Web・LINE の一斉配信・メール・サイネージの画面・予約・期間の後）、
                 ツール（tools.ts。announcements.draft・revise・recipients・submit・list・publish・closures）、付属の業務（agents.ts。下書き・出す）
src/contracts/   契約の管理（内蔵の拡張。第38章の段 1）。項目の読み取りと期限の計算（extract.ts。推論の JSON と決まった言い方・申し出の日数・更新の期間）、
                 置き場（store.ts。PostgreSQL とメモリ）、処理（service.ts。契約書・契約書チェックの実行・手で入れる・直す・削除・
                 ドライブの置き場・契約書を開く・期限の見張りと自動更新の繰り越し）、ツール（tools.ts。contracts.find・register・update）、付属の業務「契約の台帳」（agents.ts）
src/reservations/ 会議室・社用車・備品の予約（内蔵の拡張。第37章の段 1）。置き場（store.ts。PostgreSQL は期間の重なりを断る制約で、メモリも同じように断る）、
                 処理（service.ts。予約できるものを足す・直す・止める・並べ替え、予約する・空いているものを選ぶ・変える・取り消す・終わった、
                 重なったときの次に空く時間とほかのもの、予約した人の Google カレンダーの予定、1 年で消す、繰り返しの予約（段 2））、包み（package.js）。
                 日程調整で会議と一緒に会議室を取るのは tools/workspace.ts の calendar.create（room）
                 秘書の頼みの読み方と答えは src/secretary/reservations.ts
src/subsidies/   補助金・助成金の案内（内蔵の拡張。第39章の段 1・段 2）。調べ先（jgrants.ts。jGrants の公開の API と見本・所在地は市区町村まで・
                 従業員の数の幅・対象の地域）、置き場（store.ts。PostgreSQL とメモリ）、処理（service.ts。会社のこと・jGrants と Web の調べもの・
                 推論の見立て（出典の無い制度を出さない）・1 日 1 回・見送りは出し直さない・月の調べものと締め切りの知らせ）、
                 ツール（tools.ts。subsidies.find・search・mark・brief）、付属の業務「補助金・助成金の案内」（agents.ts）。
                 段 2 で朝のブリーフ（subsidies.brief）・「気になる」にした公募の読み直しと変更の知らせ・相談先の地域の窓口
src/members/     会員とポイント（内蔵の拡張。第40章の段 1・段 2）。置き場（store.ts。会員・追記のみのポイントの記録・特典。数は記録から求める）、
                 処理（service.ts。会員を作る・来店は 1 日 1 回・購入は率で換算して金額を残さない・特典・取り消し・調整・まとめる・削除・
                 有効期限の失効・LINE の ID トークンを確かめる口）、会員証（card.ts。紙のカードの PDF・QR・会員証のページと LINE の入口の HTML）、
                 ランク（service.ts の rankCutOf・rankOf。第40.19節）、サイネージの特典の 1 枚（screen.ts）、
                 ツール（tools.ts。members.find・points・rewards・rank・send_line）、付属の業務「会員とポイント」「会員に LINE で知らせる」（agents.ts）。
                 段 2 で週の見立て・会員への LINE の知らせ（承認の後）・誕生日と誕生月の特典
src/print-designs/ 販促物の作成（内蔵の拡張。第41章の段 1）。型 12 種と組み版（templates.ts。mm の SVG・塗り足し・配色 3 通り・字の大きさを枠に合わせる）、
                 書き出し（render.ts。案の小さな画像・印刷の解像度の PNG・実寸と入稿用の PDF）、点検（checks.ts。曜日・連絡先・入りきらない文・推論の誤字と表示の決まり）、
                 置き場（store.ts）、処理（service.ts。3 案・会話で直す・文面を直す・作り直す・書き出し・掲示の期間の見張り）、
                 ツール（tools.ts。print.create・revise・remake・find・signage・announce）、付属の業務「販促物の作成」（agents.ts）。
                 段 2 のつなぎ（第41.18節）: 店頭サイネージに流す・外す、お知らせの下書き、在庫の品目から値札のシート（templates.ts の price-sheet）。
                 段 2 の残り（第41.19節）: 同じ型で何枚も（文面の pieces）・特典のポップ・ドライブの写真（PrintDrive）、
                 Canva とのつなぎ（canva.ts。本物の口・見本・本人ごとの接続の置き場・CanvaService）。
src/cards/       名刺管理（内蔵の拡張。第27章）。置き場（自分だけの名刺は持ち主でも行を絞る）、読み取り（read.ts。写っている名刺ごとに項目・向き・四隅・表か裏か・英語の表記・裏の文。
                 名刺の裏面の組み方と足し方は back.ts。第27.5.1節）。
                 四隅は文字の向きに合わせて並べ直す orderCorners。1 枚の写真に 10 枚まで）、同じ人の見分け（identity.ts）、
                 表（CSV・Excel）の取り込みと書き出し（table.ts。見出しはよくある言い方と推論で読む）、
                 メールの署名から異動・昇進・電話の変更を見つけて名刺を新しくする見張りと、戻す値の決め方（signature.ts。第27.6.1節）、
                 名刺の相手へのまとめてのメール（bulk.ts。下書き・除く人・見本・承認した要約の照合・1 人 1 通の送信（お知らせの作成では窓口のアカウントから）・配信の停止。第27.9.1節）、
                 取り込み・修正・範囲・分ける・消去（service.ts）、PDF の分け方と形式（formats.ts）、vCard、ツール、付属の業務、
                 本人の Google の連絡先へのつなぎ（google-contacts.ts。入れる・新しくする（Google で直した項目は残す）・外す・自動・見回り。第27.15節）
src/signage/     店頭サイネージ（内蔵の拡張。第31章の段 1・段 2・段 3 の時間帯の流れと在庫の入荷・品切れの案内（stock.ts））。置き場（画面・ふだん動いている時間帯・登録の番号・素材・流れ・時間帯の流れ・在庫の案内・割り込みと出す先・
                 よく出す案内・呼び出しの受け口・会社の音。PostgreSQL）、割り込み（interrupts.ts。並び・まとめる・古いもの・消す・よく出す案内・
                 受け口の読み方と骨組みからの推測・会社の音）、
                 処理（登録と画面の鍵・素材の確かめ・流れの版・再生のページへの答え・生きている知らせ・つながらない知らせ。service.ts）、
                 MP4 の入れ物の記録を読む（mp4.ts。H.264 か・長さ・縦横）・画像の縦横（image-size.ts）。
                 秘書からの依頼は src/secretary/signage.ts（本人の発言を見分けてその場で行う。割り込み・渡された画像を流れに足す・時間帯・設定。ツールの一覧に載せない）
src/columns/     Web のコラム（内蔵の拡張。第32章の段 1・段 2）。置き場（コラムと版。PostgreSQL とメモリ。store.ts）、書く・書き直す（writer.ts。
                 Web の調べもの → 推論の JSON。見本の推論では見本の下書き）、赤入れ（review.ts。表現の決まりごとの言葉の一覧と推論・直し案）、
                 WordPress（wordpress.ts。REST API とアプリケーションパスワード・下書きとして入れる・カバーをアイキャッチにする・つながるかの確かめ）、
                 当てる表現の決まりの選び方（rules.ts。業種・分野・読み手・監修者から推論と決まった言葉で選ぶ）、
                 カバー画像（cover.ts。型の模様・題名の折り返しと重ね・SVG から PNG（@resvg/resvg-js）・AI の挿絵と描いた後の確かめ・写真の説明と選び方）、
                 店頭サイネージ用の画像と動画（signage.ts・signage-store.ts。場面の分け方・字を組んだ 1920×1080 と 1080×1920 の画像・Veo の 15 秒の動画と英語の指示と確かめ・承認の後に流れの先頭へ・30 日で外す。第32.18.6節）、
                 処理（service.ts。裏で書き上げ・版・承認待ち・版の指紋（公開の日時を含む）・入れる・予約から入れる・取り下げ・削除・鍵を預ける）、
                 段 2 の決まり（plan.ts。予定表の回・テーマ案の推論と決まった形・似すぎの確かめ）、段 2 の処理（planner.ts。テーマ案（ニュースの調べものを 24 時間使い回す）・先回りと飛ばす回・
                 予約・貼るだけのページ・ワーカーの tick）、テーマ案の材料（materials.ts。Webの分析・競合の分析・問い合わせの記録から）、
                 ツール 7 つ（columns.draft・preview・place・cover・rules・themes・prepare）、付属の業務「コラムの下書き」「コラムを WordPress に入れる」ほか
src/inquiries/   問い合わせの記録（内蔵の拡張。第33章の段 1〜3）。置き場（問い合わせ・会話の履歴・次にやること。PostgreSQL とメモリ。store.ts）、
                 項目の取り出し（extract.ts。推論の JSON と決まった言葉・期限の読み方・要配慮個人情報を除く）、処理（service.ts。残す・続き・直す・
                 次にやること・削除・絞り込み・本人から求められたときのまとめての削除）、名刺管理とのつなぎ（contacts.ts）、見張り（watch.ts。期限と手つかずの知らせ・原文を 90 日で消す）、
                 窓口のアカウント（mailbox.ts。Gmail API と見本の箱）、メールの見分け（mail.ts）、月の振り返り（review.ts）、
                 LINE 公式アカウント（line.ts。署名の確かめ・Messaging API と見本の口・メッセージの読み方）、
                 ツール（tools.ts。inquiries.record・list・reply_draft・reply_send・brief・review・faq）、付属の業務（agents.ts。残す・調べる・返事の下書き・返事を送る）、
                 ほかの拡張へのつなぎ（links.ts。Webの分析の月の便りに並べる月の件数。件数だけ）。送った返事から会社の知識にする（service.ts の learnFromReply。第33.20節）
src/competitors/ 競合の分析（内蔵の拡張。第36章の段 1〜3）。公開のページを読む口（fetcher.ts。つなぐ瞬間に社内のアドレスを断る・見本の口）、
                 robots.txt（robots.ts。RFC 9309・24 時間覚える）、HTML の読み方（html.ts）、Places API（places.ts。見本の地図）、
                 推論（analyze.ts。自社の像・商圏・候補の確かめ・読むページ・事実・レポート）、1 サイトを読む（reader.ts）、
                 置き場（store.ts。PostgreSQL とメモリ）、処理と作業（service.ts。探す・入れる・外す・読む・レポート・ワーカーの CompetitorWatch）、
                 ツール（tools.ts。competitors.list・facts・report・discover・add・remove・check）、付属の業務（agents.ts。探す・分析）、
                 ほかの拡張へのつなぎ（links.ts。月の動きの数・話題を載せている競合の数。名前は渡さない）
src/web-review/  Webの分析（内蔵の拡張。第34章の段 1・段 2）。担当の許可で読む口（data.ts。GA4 のデータと管理の API・Search Console の API と URL の検査・PageSpeed Insights・
                 見本の口 MockWebData）、数字（figures.ts。期間・サイトの選び方・月の便りの数字・秘書の問い。数字はここで計算する）、
                 置き場（store.ts。月の便り・直すべき所・ページごとの数字。PostgreSQL とメモリ）、処理（service.ts。つなぐ・外す・選ぶ・状態と依頼文の下書き・問い・
                 月の便りと知らせ・直すべき所の見回り・ワーカーの tick）、直すべき所（findings.ts。6 つの種類の基準・依頼文の下書き・案の推論）、
                 コラムとのつなぎ（columns.ts。公開されたコラムの URL を WordPress から読む）、
                 ツール（tools.ts。web_review.report・ask・status・select・findings・request_send）、付属の業務（agents.ts。Web について聞く・Web の依頼文を送る）
src/apps/        外部のアプリ（第13.4.1節）。アプリの置き場（PostgreSQL とメモリ）、登録・承認・鍵（m2oa_。ハッシュだけを持つ）・停止・削除、
                 機能ごとの道（appFunctionFor）・回数の上限・呼び出しの数・書き込みの通知を二重に数えない番号（service.ts）
src/inventory/   在庫管理（内蔵の拡張。第29章）。置き場（入出庫の記録と同じトランザクションでいまの数を直す。PostgreSQL とメモリ）、
                 バーコードの読み方（gs1.ts。GS1・JAN・UPC）、品目・場所・入出庫・使用期限の近いロットから減らす・取り消し・
                 棚卸し（会社で 1 つ・数えた時点の帳簿と比べる・確定で差を調整に）・取り込みと書き出し（service.ts）、
                 棚のラベルの PDF（labels.ts。QR は qrcode）、見張りの計算（forecast.ts）と知らせ（watch.ts）、
                 納品書の読み取りと照らし合わせ（slip.ts）、予約との引き当て（bookings.ts。受け口・項目の対応の推論・メニューで使う品目の
                 推論と学習・取り置き・使った・取り消し）、Web への公開（publication.ts。承認・停止・作り直し・埋め込みのページ）、外部のアプリの在庫の機能（sales.ts。商品の一覧・販売の通知の取り置き／使用／取り消し／返品・照らせない行。第29.20.1節）、JAN から商品名を引く（jan.ts。Gemini の Google 検索）、ツール 7 つ、付属の業務「在庫の記録」「納品書から入庫」「発注の下書き」
src/hr/          人事・給与（内蔵の拡張。第30章）。段 1: 置き場（従業員・雇用条件の履歴・入退社の手続き。PostgreSQL）、
                 手続きの一覧と期限（procedures.ts。決まったプログラムで作る）、台帳・取り込み（見出しを推論で読む）・労働者名簿（service.ts）、
                 人事区画の確かめと用意（hrAccess・ensureHrCompartment）。段 2: 勤怠の集計（attendance.ts。日 8 時間・週 40 時間・
                 深夜・法定休日・60 時間超・点検・締めの期間・36 協定）、有給（leave.ts。付与の表・時効・古い順・取得義務）、
                 打刻・直し・締め・出勤簿・申請・管理簿・知らせ（attendance-service.ts）、置き場（attendance-store.ts）。
                 段 3: 月の給与の計算（payroll.ts。割増・欠勤控除・社会保険料・支援金・雇用保険料・所得税・住民税と行ごとの根拠）、
                 給与の情報・標準報酬月額・家族・下書きの回（payroll-service.ts・payroll-store.ts）、
                 法令の表（law/。公式の発表から取り込んだデータのファイルと出典・監修の状態、使う日で引く Law）。
                 段 4: 回の点検（payroll-review.ts）・確定と明細の配布と振込データと賃金台帳（payroll-service.ts）・
                 全銀協の形式（zengin.ts）・明細の PDF（payslip-pdf.ts）・住民税の決定通知書の読み取り（resident-notice.ts）・
                 試しの計算（payroll-trial.ts）。
                 労働条件通知書（terms-notice.ts）・労務カレンダー（calendar.ts・calendar-service.ts）・ツール hr.deadlines（tools.ts。朝のブリーフが読む）、
                 規程から設定の案（rules-proposal.ts）・法令の表の見張り（law/lookup.ts の staleAt・changesBetween）。
                 Phase 2 段 1: 賞与の計算（bonus.ts。算出率の表 law/bonus-2026.ts）・調整の行と訂正の回（payroll.ts・payroll-service.ts）。
                 段 2: 年末調整の計算（yea-calc.ts。年末調整の決まり law/yea-2026.ts）・申告（yea-store.ts）・年末調整の回と精算（yea-service.ts）・
                 控除証明書の読み取り（yea-certificate.ts）・源泉徴収票の PDF（withholding-pdf.ts）。
                 段 3: 社会保険の判定（social.ts。適用の決まり law/insurance-2026.ts・等級表の随時改定の特例）・届出と標準報酬月額の反映（social-service.ts）・
                 届出の記録（social-store.ts）。
                 段 4: 年度更新の計算（labor-insurance.ts。労災保険率表 law/workers-comp-2024.ts）・処理（labor-service.ts）・置き場（labor-store.ts）。
                 段 5: シフトの案づくりと点検（shift-plan.ts）・処理（shift-service.ts）・置き場（shift-store.ts）・変形労働時間制の集計（attendance.ts の variableTotals）。
                 帳簿をまとめて ZIP で書き出す（books-export.ts。解約のときに渡す）、
                 顔写真を人に当てる（photos.ts。ファイル名と写真の中の名札。顔からは見分けない）、
                 1 年単位の変形労働時間制とフレックスタイム制の計算（work-systems.ts。3 段と対象期間の清算・所定の点検・清算期間）・
                 共有の端末での打刻（terminal.ts。登録・30 秒ごとに変わる QR・名前と番号。第30.6.3節）
src/secretary/   秘書。3 層の応答振り分け、定時実行の確認・停止・再開・今すぐ実行（推論なし。第10.9.8節）、
                 社内のお知らせを出す・取り下げる・並べる・済んだにする（notices.ts。第10.15節）
                 在庫の依頼の見分けと、在庫の数の問いへのその場の答え（inventory.ts。第29.15節）
src/brief/       朝のブリーフの人ごとの中身（第9.5.5.1.1節）。秘書が最初の関心の分野を選ぶ・会話で直す（settings.ts）、ツール brief.settings
src/notices/     社内のお知らせ（第10.15節）。置き場（PostgreSQL とメモリ）、宛先・期間・初めて載せたか・済んだ・取り下げ（service.ts）、ツール notices.list。
                 第10.15.1節の届け方（合う Chat のスペースへの投稿・締切の前の知らせ・済んだ人の数・もう知らせない）
src/machine/     ローカルの形の「機械」（status.ts。各部の動き・ディスク・証明書・ローカル AI）と控え（backup.ts。pg_dump と rsync・残す数・戻せるかの確かめ。第8.6.5節・第8.6.7節）と社外の控え（offsite.ts。restic で暗号化して S3 互換の置き場へ・残す数・毎月の確かめ）と、更新の様子（update.ts。deploy/onsite/update.sh が書いた結果・止める／延ばす印・失敗の知らせ。第8.6.4節）、遠隔の保守の印と記録（maintenance.ts。同じ機械の M2Medical が持つときは開けない。第8.6.9節）、運営への稼働の知らせ（heartbeat.ts。件数と状態だけ。第8.6.8節）
src/ops/         マスター管理画面の決まり（rules.ts。会社を作る入力・ロール・稼働の知らせの形・機械の印）と、運営の専用のロールでのデータベースの口（store.ts。仕様書 第23.8.15節）と、アプリのロールの側の口（app-side.ts。ワーカーの知らせ・毎晩の数の記録・運営主体の読み出し・停止の期限・代理アクセスの終わりの知らせ）と、代理アクセス（proxy.ts。見るだけの道・申請と閲覧のログイン状態。第23.6.1節）
src/app-root.ts  実行中に読むファイルの置き場所の根（M2O_APP_ROOT。本番の組み立てで使う。第20.4.5節）
src/usage/       AI の利用の記録と上限（ai-usage.ts。呼び出しの包み・会社と 1 人の月の上限・8 割と 10 割の知らせ・暴走の見張り。第6.6.2節、ADR-0079）
src/meetings/    会議が終わったら主催した人の議事録を作り始める見回り（auto-minutes.ts。第9.5.2.1節、ADR-0081）
src/evals/       評価の決まった規則での採点（score.ts。契約書チェックの見つけるべき点・出てはならない言い回し・冒頭の表示。第28.15節）
test/            単体テスト（DB を使わない）
```

## 中心にあるもの

### 推論が使えない会社（`llm/unconfigured.ts`）

**推論（Gemini）が使えない会社では、秘書も業務も動かしません**（仕様書 第20.2.4節、ADR-0030）。
`platformAi()`（`secrets/tenant-ai.ts`）が運営の設定から、会社の鍵が無いときの推論を決めます。運営の鍵があれば Gemini、
`LLM_PROVIDER=stub` なら自動テスト用のスタブ、どちらでもなければ `UnconfiguredLlmProvider`（`name: 'unconfigured'`）です。
秘書（`Secretary.respond`）・実行エンジン（`RunEngine.advance`）・業務の受け付け（API）・音声（`TenantAiResolver.voiceFor`）は、
`aiAvailable()` で見分けて推論を呼ばずに断り、`AI_NOT_CONFIGURED_MESSAGE` を返します。見本の応答で動いたように見せません。

### 実行エンジン（`RunEngine`）

承認ゲートで中断し、承認後に**別のプロセスから**再開できることが要件です。
そのため状態はすべて永続化層から読み直し、メモリ上の文脈に依存しません。

```
advance(run)  →  完了 / 承認待ち / 失敗
decideApproval(...)  →  承認を記録し、待ち行列へ戻す
```

承認後は次に空いたワーカーが担当します。中断したワーカーが再開するとは限りません。

### 定義の検証（`validateDefinition`）

導入時と実行開始時に呼びます。とくに次を拒否します。

- 登録簿に無いツールの要求
- 危険度 `external-send` 以上のツールを使うのに承認ゲートが無い定義

この規則は基盤側が強制し、**定義側の記述で緩めることはできません**（仕様書 第9.4節）。

### 承認ゲートの実行時の強制

定義の検証に加え、**実行中にも**止めます。`external-send` 以上のツールは、
承認ステップの直後のステップでのみ呼べます。それ以外で呼ぼうとした場合は実行せず、
監査ログに `tool.blocked` を残します。

定義に承認ステップがあっても、その手前で推論が送信を試みれば送られてしまうためです。
メール本文に紛れた指示（不変則 I-6）で起こりえます。

承認・却下は、承認ステップが指定した者だけが行えます（仕様書 第9.2.3節）。
既定はロールで判断し（`approverRole`）、`approver: 'requester'` では依頼した本人だけが判断できます。
判定は `@m2office/shared` の `canDecide()` 1 か所にまとめています。
判断できない場合は `ApprovalForbiddenError` です。

### 接続口（`WorkspaceConnector`）

ツールは Google の API を直接呼ばず、接続口だけを呼びます（仕様書 第24.2節 第 6 項）。
`buildConnector('mock')` はダミーデータを返し、戻り値に `source: 'mock'` を含めます。
`buildConnector('google', { repo, box })` は **Gmail・カレンダー・ToDo・Chat・ドライブ・ドキュメント・スプレッドシート・スライドを本物の Google で**動かし、
ほかのサービスは「準備中」と断ります（`src/connectors/google/`。仕様書 第14.3.4節、ADR-0022）。
見本のデータで代わりに動かすことはしません。

| ファイル | 内容 |
|---|---|
| `google/http.ts` | 本人のアクセス トークン（メモリにだけ持つ）と、Google の失敗を「断るときの言葉」に直す呼び出し |
| `google/mime.ts` | 本文の取り出し（宣言された文字コードで戻す。添付は読まない）と、送るメールの組み立て |
| `google/index.ts` | Gmail・カレンダー・ToDo・Chat の本体。準備中のサービスの断り |
| `google/drive.ts` | ドライブ（探す・読む・フォルダ・共有）とドキュメント（作る・追記）。`drive.file` の範囲だけで、リンクによる公開は作らない |
| `google/sheets.ts` | スプレッドシート（作る・最初のシートを読む・行を足す）。値は `RAW` で送り、式として読ませない |
| `google/slides.ts` | スライド。会社のテンプレートがあれば本人のドライブに複製し、見本のスライドを複製して差し込む（ADR-0032）。無ければ標準の見た目で組み立てる（ADR-0031）。失敗したら作りかけをごみ箱に移す |
| `google/doc-html.ts` | 文書の本文（Markdown）を、ドキュメントに取り込ませる HTML に直す（中身はエスケープする） |
| `google/chat.ts` | Chat の投稿先の見つけ方（リンク・ID か、名前でちょうど 1 つ一致）と、本文の書式 |

呼べないときは `ConnectorUnavailableError`（理由の種類つき）を投げます。
エンジンは、読むだけのツールならこれを受けて「取得できませんでした」と推論に返し、書くツールならステップを失敗にします。
値の出どころは会社ごとに `sourceFor(tenantId)` で引きます（開発では `CONNECTOR_MOCK_TENANTS` で会社ごとに見本にできるため）。

### 承認の画面と、承認の前の組み立て

承認の段に来ると、エンジンは**その直後の段を先に組み立て**、社内への書き込みと社外への送信は記録だけして止まります（仕様書 第9.3.3節、ADR-0023）。
承認の画面には「確認すること・判断するもの・承認すると行うこと」を業務の言葉で出し（`engine/approval-present.ts`・`engine/describe-call.ts`）、
承認されたら**記録した操作をそのまま**実行します。承認のあとで推論し直さないので、承認した人が見た本文と送られる本文が同じになります。
段が `tools` を宣言していれば、その段ではそれ以外のツールを呼ばせません（第9.2.7節）。推論には毎回、今日の日付（日本時間）を渡します。

**人に判断を求めるのは、社外に出るものとお金の確定だけです**（仕様書 第9.4.0節、ADR-0028）。組み立てた操作を `needsHuman()` で見て、
社外に出るもの（送るツールで、送り先が社内だけと確かめられなかったもの。メールは常に）・お金の確定（`financial`）・会社が「承認が必要」にした社内への書き込みのどれも無く、
行えない操作も無ければ、承認の段を**人を待たずに通し**（`passAutomatically()`。記録は「自動で通過」、監査ログ `approval.auto`）、記録どおりに実行します。
送り先の確かめはツールの `prepare` が返す `audience` で、Chat はスペースの `externalUserAllowed`、共有と招待は相手のドメイン（`audienceOf()`）で決めます。見本の接続口では常に社外です。

記録する前に、ツールが `prepare`（承認の前の確かめ。読むだけ）を持っていれば呼びます（ADR-0024）。
`ready` なら確かめた引数で記録し（例: `chat.post` はスペースの名前を `spaces/…` にし、承認のあとは探し直さない）、
`problem` なら記録せずに承認の画面の「次のことは行えません」に理由を出し、`unchecked`（Google に届かない）なら記録して「確かめられませんでした」と添えます。
組み立ての中で実行した下書き（`docs.create` で Google ドキュメントに保存したことなど）は、承認の画面の「承認の前に済ませたこと」に出します（ADR-0025）。

### 社内への書き込みの操作確認

`write-internal` のツールは、会社の自動化ポリシーで承認が必要なら実行の直前で止まり、
依頼した本人に確認を求めます（仕様書 第9.4節）。承認されると**記録した操作そのもの**を
実行し、推論をやり直しません。直前が承認ステップなら確認は不要です。

### データベースの行レベルセキュリティ

`PostgresRepository` は問い合わせごとにトランザクションを張り、`app.tenant_id` を設定します。
接続は `m2office_app` ロールで行い、RLS を迂回できません。テナントを横断するのは
待ち行列の確保と定時実行の候補の列挙だけで、データベース関数に閉じ込めています。

### 文書を扱う共通ツール

| ツール | 危険度 | 内容 |
|---|---|---|
| `sheet.read` | read | Excel・CSV を表として読む。Shift_JIS の CSV も読む |
| `sheet.render` | draft | 表を Excel・CSV（BOM 付き UTF-8）で出力する |
| `pdf.extract` | read | PDF から文字を取り出す。文字の無いページは、そのページだけを抜き出した PDF を読み取りへ送る（10 ページまで。Q-56） |
| `docx.render` | draft | Word 形式で文書を出力する |
| `pdf.render` | draft | 帳票（請求書など）を PDF で出力する。日本語の一部に絞った Noto Sans JP を同梱し（`assets/fonts/README.md`）、使った文字だけを埋め込む。範囲の外の字は `〓` に置き換えて返す（Q-59、ADR-0017）。会社の帳票の体裁（第15.2.2節）は `loadInvoiceStyle()` で読み、ロゴ・差出人・振込先・備考の定型文・印の欄を出す |
| `image.read_text` | read | 画像（PNG・JPEG）から文字を読み取る（OCR）。推論を使うため確かな値ではない（Q-56） |
| `web.research` | read | テーマを Google 検索（Gemini のグラウンディング）で調べ、出典つきで返す |
| `slides.template` | read | 会社が登録したスライドのテンプレートの、見本のスライドと差し込み口を読む（`describeTemplate()`） |
| `slides.create` | draft | スライドの構成（JSON）から Google スライドを作る。会社のテンプレートがあれば見本に差し込む。見本の接続口ではアウトラインを成果物に残す |

エージェントが読めるのは依頼した本人のファイルだけです。ライブラリの選定は ADR-0004 を参照してください。
`web.research` と `slides.create` は AI Radio の秘書の実装を移植したものです（ADR-0006）。構成の検証は `normalizeSlidePlan()` です。

### Google Workspace のツール（`tools/google.ts`）

仕様書 第9.4.4節の一覧の第 1 弾（Gmail の検索・送信、予定の変更・取り消し、ToDo の完了、ドライブ・ドキュメント・スプレッドシート）と
第 2 弾（M2Office が作ったファイルの共有、社内の人の検索、Meet の文字起こし）、第 3 弾（フォームの回答）。
すべての内蔵ツールは `args`（引数の定義）を持ち、実行エンジンは呼ぶ前に `validateToolArgs()` で確かめます（誤りは呼ばずに理由を返す）。
Google を使うツールは `google`（必要な権限と段階）を持ちます。制限付きの権限は Gmail の読み取り・下書きだけに限り、
ドライブは `drive.file` で作ります（第14.3.2節、CASA に備えた作り）。開発者マニュアルの一覧は `npm run docs:tools` で作ります。

### 削減時間の推計

最後まで完了した実行に、そのエージェントの標準所要時間（分）を記録します（仕様書 第6.7.12節）。
既定値は `DEFAULT_STANDARD_MINUTES`、会社ごとの値は `TenantSettings.effect` です。
途中で終了した実行は 0 分です。記録した値は後から変わりません。

### ヘルプ

`buildAgentHelp()` がエージェント定義から業務の説明を組み立てます（仕様書 第6.10.5節）。
「この業務がすること」はツールの `helpText`、承認が入る場所は承認の段から
機械的に作るため、定義を追加するだけで正しい説明が出ます。
`HelpCatalog` は公式の記事（`docs/help/`）と業務の記事、業務のマニュアルの章（`docs/manual/`。`parseManual`）を合わせ、役割・有効な業務・使える内蔵の拡張・出す所（ワークスペースか管理者ページか）で出し分けて検索します。秘書の答えの材料にはマニュアルの章を入れません。
ツールを追加するときは、`activityLabel`（ダッシュボードの活動の表示名）と `helpText`（すること）を必ず書きます。

### 組織知識の検索

知識は保存のたびに `splitKnowledge()` で節（条・章・見出しの単位）に分け、`knowledge_sections` に入れ直します（仕様書 第11.7.2節）。
検索は `extractTerms()` で質問から言葉を取り出し、データベースでは 2 文字の組で候補を絞るだけにして、
`rankSections()` の点数で並べます（第11.7.3節）。返すのは最大 5 節・合計 8,000 字で、出典は `citationOf()` の `文書名 › 見出しの経路` です。
分け方を変えたら `SPLIT_VERSION` を 1 つ上げてください。保存済みの知識は、次の検索の前に分け直されます。
言い換え（標準の `STANDARD_SYNONYMS`、以前に登録した会社の組 `knowledge.synonyms`、秘書が考えた組）は `expandTerms()` で足し、組はまとめて 1 つの言葉として数えます（第11.7.7節）。

### 知識の種類と管理（仕様書 第11.11節、ADR-0056）

知識は登録の経路で `category`（`rule`: 管理者が登録した社内規程、`minutes`: 業務が登録した議事録、`learned`: 秘書が学んだこと）に分けます（`saveKnowledge()` が `kind` と由来から決め、最初の登録のときだけ書く）。
社内規程は `saveRuleVersion()` で版を `knowledge_item_versions` に残し、施行日が今日までなら施行している版に写して節に分け直します。
施行日が先の版は、検索と一覧の前に `applyDueVersions()` が切り替えます。改定前を尋ねる質問（`asksOldVersion()`）では古い版も探し、版と施行日を出典に添えます。
検索は `status = 'active'` だけを探し、見つけた知識の `last_used_at` を記録します（整理の確かめの検索では `touch: false`）。
`Consolidator`（`knowledge/consolidate.ts`）は週 1 回、推論で同じ事柄をまとめ、新しい事実で古くなったもの・社内規程と食い違うもの（会社の知識だけ）をしまい、半年使われないものは推論を使わずにしまいます。
本人の記憶は本人ごとに推論へ渡します。しまったもの（`archived`）は 1 年、廃止した議事録は 1 年、廃止した社内規程と古い版は 7 年で `purgeKnowledge()`・`purgeArchivedMemories()` が消します。

### 業務からの知識の登録（`knowledge.register`）

AG-02 議事録の作成・共有は、承認②のあとに `knowledge.register` で議事録を組織知識に登録します（仕様書 第9.5.2節、ADR-0010）。
ツールは成果物の ID だけを受け取り、次をすべて満たすときに限って、成果物の本文をそのまま登録します。

- 呼んだステップより後に承認ステップが残っていない（実行エンジンが `ToolContext.approvalsAhead` で渡す）
- 同じ実行の成果物で、最初の承認で止めた時点にあった（承認ステップの記録の `input.artifactIds` に含まれる）

知識の ID は `run-<実行の ID>` で、同じ実行で呼び直しても増えません。
登録した実行（`originRunId`）と、Google の読み取りのツールを呼んだか（`googleDerived`）は最初の登録のときだけ書き、管理者が本文を直しても変わりません。

### 個人記憶（`secretary/memory.ts`）

本人が秘書に「〜を覚えておいて」と頼んだときに覚えます（仕様書 第11.5.1節、ADR-0012）。
会話から自分で覚える経路は、下の「対話からの学習と昇華」を参照してください（ADR-0027）。
層 1（推論を通さない経路）で完結するため、覚えた内容が指示と食い違いません。

- `memoryTextOf()` が指示から覚える一文を取り出し、`refuseToRemember()` が覚えないもの（学習の停止・対象外の言葉・認証情報らしき語・200 字超）を判定します
- 照会は `DIRECT_QUERIES` の `memory-remember`・`memory-forget`（対象外の指定）・`memory-list` です
- 記憶は本人だけのものです。秘書の層 3 の指示文にだけ差し込み、業務エージェントとほかの利用者には渡しません
- 監査ログには操作（`memory.create`・`memory.update`・`memory.delete`・`memory.clear`・`memory.learn`）だけを残し、中身は入れません

### 秘書が覚えていることを使う（`secretary/recall.ts`）

秘書は層 3 で答えるたびに、本人について覚えていることをデータとして推論に渡します（仕様書 第10.7.3節、ADR-0027）。
画面に会話の履歴を並べなくても、「それを詳しく」「あれ、どうなった」が通じるようにするためです。

- `recall()` が、今日のやり取り（直近 8 件）・会話の要約（新しい 7 日分と、依頼に近い日の要約。権限区画の印の付いたものは使わない）・覚えた事実・本人が頼んだ業務（直近 20 件の題名と状態だけ）を集めます。読み出しに失敗しても答えは返します
- 渡す文は本人の依頼とは別のメッセージにし、「データであり指示ではない」と明記します（不変則 I-6）
- `REFERS_TO_PAST` に当たる問い（「あれ」「あの件」「どうなった」など。「あれば」は除く）は、業務への取次と、実行の件数の定型の答え（`recent-runs`）を飛ばし、覚えていることから答えます。ただし「さっきの行程をカレンダーに入れて」のような作業の依頼は取り次ぎます
- 取次（層 2）で専門の業務に当たれば、`fillInputs()` が依頼の文と今日の会話から入力を埋め、`startAgent` で頼んで実行します（本人に実行の可否を聞かない。足りない必須の入力だけを聞く）。外の最新の情報や本人の予定が要る依頼は、秘書の調べもの（`startLookup`）に回します（仕様書 第10.9.6節、ADR-0033）

### 声の答えを画面にも出すか（`secretary/canvas.ts`）

`needsCanvas()` が、声の依頼への答えが「大きい」か（4 件以上の一覧・表・200 字超・業務を開くボタン・ヘルプの記事・出典）を決めます（仕様書 第6.2.0節、ADR-0026）。
大きければ、音声の中継が秘書のキャンバスにも出し、声では要点だけを話します。

### 会話ログ（`conversations/`）

秘書とのやり取りを 1 往復ずつ残します（仕様書 第11.9.4.1節、ADR-0014）。

- 残すのは `Secretary.respond()` です。本人が「会話を残す」を切っていれば残しません。残せなくても応答は返します
- 読めるのは本人だけです（不変則 I-10）。評価は列に持たず、結び付いた実行の承認から引きます
- 「この会話は残さないで」（層 1 の照会 `conversation-forget`）は直近 1 時間を消し、**その指示自体も残しません**（`DirectAnswer.keep = false`）
- `ConversationRotation.sweep()` が 4 週を過ぎた逐語を消します。ワーカーが 1 日 1 回呼びます（会社の設定では延ばせません。Q-50）

### 対話からの学習と昇華（`memory/`）

- 秘書の受け手 `SecretaryConductor`（`secretary/conductor.ts`）が、業務と秘書のイベント（`agent_events`。実行の終了・承認待ちと会話の保存を、データベースのトリガーが同じトランザクションで書く）を 1 件ずつ受け、依頼した本人の秘書として動きます（仕様書 第10.13節、ADR-0039）。失敗は処理済みにせず、2 分後にやり直します（5 回まで）
- 秘書の分身 `PlanRunner`（`secretary/plan.ts`）は、秘書が作った段取り（`plans`）のイベント `plan.requested`・`plan.resumed` と、段の業務（ジョブの `planStepId`）の終了を受けて、段取りを立て（標準のモデル 1 回）、本人が使える業務を本人として起こし、前の段の答えを次の段の入力の材料にし、足りない入力は本人に 1 回だけ聞き、すべて終わったら中の業務「段取りの報告」（`secretary-plan-report`）を起こします。段は 8 つ・同時に 3 つ・頼み直しは各 1 回まで。権限区画の答えは区画の外の業務に渡しません（仕様書 第10.14節、ADR-0040）
- `MemoryLearning.learnNow()` は、会話の 1 往復か、本人が直接使って完了した業務の依頼と答え（`memory/work.ts`。秘書が伝えた業務と権限区画の業務は除く。ADR-0038）から、**その場で**今日の要約（依頼・決定・やりかけ・約束や期限・関わった人）に書き足し、**大事な事実をそのまま覚えます**（`source: 'learned'`。仕様書 第11.5.2節、ADR-0027）。推論が見本（`stub`）の環境では覚えません。以前の形で残っていた候補（`pending`）は `adoptLegacyCandidates()` で記憶にします
- 同じ文は二度覚えません。本人が消した・直した秘書の記憶は `dismissed` の候補として残し、再び覚えないための印にします
- 新しく覚えたことがあると `promote()` で、その人のまだ判断していない記憶から**ほかの人にも役立つもの**を推論に選ばせ、**そのまま組織知識（`kind: 'promoted'`、出典「秘書が会話から学んだこと」）に登録します**（第11.3.1節、ADR-0028。本人・管理者の承認は求めない）。番号だけを選ばせ、記憶の文は書き換えません。選ばなかった記憶も判断済み（`rejected`）として残し、選び直しません。すでにある知識と同じ文は重ねません
- 秘書が答えるとき（`recall()`）は、本人の仕事の記録のうち今日完了した業務に答えの要点を添えます（第10.7.3節、ADR-0038）
- 以前の二重の承認の関数と API（ADR-0016）はなくしました。`memory/promotion.ts` には、秘書が付ける知識の題名（`promotionTitle()`）だけが残っています

### 会話で記憶を直す（`secretary/correct.ts`）

「それは違う」「〇〇は忘れて」のような言い方（`CORRECTION`）に当たると、秘書は `correctMemory()` で本人の記憶と、本人の記憶から秘書が会社の知識にしたものを推論に照らし合わせさせ、
直す・消す・覚え直すを自分で行います（仕様書 第11.5.3節）。当たる記憶が決められなければ聞き返し、記憶の話でなければふつうの答えに戻ります。管理者が登録した規程は直しません。

### 言い換えを秘書が考える（`knowledge/expand.ts`）

組織知識を探すたびに、`expandQuery()` が高速の推論に質問の言葉の言い換えを挙げさせ、`searchKnowledge()` の 4 つ目の引数に渡します（仕様書 第11.7.7.0節）。
登録した言い換えと同じように効き、2 秒で打ち切ります。推論が使えなければ標準の言い換えだけで探します。

### 人の状態（`dashboard/presence.ts`）

ダッシュボードの「人の状態」を、既存の記録から組み立てます（仕様書 第6.7.4.1節、ADR-0013）。

- 状態のための表は作りません。ログイン状態・実行とステップ・承認・監査ログから、そのつど決めます（履歴を残さないため）
- 強い順に、承認の依頼あり → 活動中 → 業務を実行中 → 秘書と会話中 → 待機 → オフライン
- 「活動中」は、実行エンジンがツールを呼ぶ直前にステップへ書く活動の表示名（`Tool.activityLabel`）を読みます
- `summarizePresence()` は、個人名を出さない会社（`TenantSettings.dashboard.people = 'counts'`）向けに人数と業務名だけにします

### 音声の対話（`voice/`）

音声は「音声の対話」の接続口 1 つの後ろに閉じています（仕様書 第10.5.4節、Q-35、ADR-0018）。

- `VoiceProvider.open()` が返すのは、音を送る・文字と音を受け取る・終わる、だけの口です。画面と中継は提供者を知りません
- `GeminiLiveProvider` が Gemini Live 固有の形（`setup`・`realtimeInput`・`serverContent`）を担います。鍵はサーバーだけが持ちます
- 鍵が無い会社では音声を始めず、「Gemini の接続が設定されていません」と伝えます（`AiNotConfiguredError`。仕様書 第20.2.4節）。`MockVoiceProvider` は自動テスト（`LLM_PROVIDER=stub`）の中だけで使います
- 音は通すだけで、どこにも書き出しません（第10.5.3節）。会話ログに残すのは文字だけです
- 声（`VOICE_CHOICES` から本人が選ぶ）は `speechConfig` で、話し方の指示（例: 関西弁で話して）は指示文の末尾で渡します（第10.5.6節）。知らない声の名前は中継が落とします

### 通知と、その控え（`notify/`）

画面内のお知らせが正で、Chat はその控えです（仕様書 第6.5.5.2節、ADR-0011）。メールは送りません（Q-86）。

- 秘書の先回り（`secretary/proactive.ts` の `ProactiveWatcher`）は、ワーカーから 10 分ごとに呼び、会議の 20〜60 分前に会議の準備を、17 時以降に翌日の移動の調べものを起こします。「あとで〇〇する」を ToDo に入れるのは `Secretary` の中です（仕様書 第10.12節）
- 朝のブリーフ（`agents/morning-brief.ts`）は通知を作らず、秘書の答えとして届けます（仕様書 第9.5.5.1節）。本人の自宅・勤務地はツール `profile.read`（`tools/profile.ts`）で読みます
- 通知を作るのは実行エンジン（承認依頼・完了・失敗）と `notification.send`（週次ブリーフ）です。本人が受け取らないと決めた種類は作りません
- 控えを届けるのは `NotificationDelivery.sweep()` で、ワーカーが一定の間隔で呼びます。送るのは種類・題名・画面へのリンクだけです
- 送信口は `NotificationSender`。いまは `MockNotificationSender`（送ったことにして控える）で、会社の Chat アプリ（B-2）の後に差し替えます
- 通知しない時間帯の間は送らず、`delivered_at` を空のままにして次の見回りで送ります。送れないまま 24 時間たったらあきらめます（画面内のお知らせは残ります）

### 拡張機能（`ExtensionHub`）

拡張機能は「ファイルの集まり」として検証します（`loadExtensionFiles()`）。ディレクトリから読んでも（`loadExtension()`）、
`.m2ext` を展開しても（`unpackExtension()`）、同じ検証を通ります（仕様書 第12.9.2節、第12.10.2節）。
入れてよいファイル以外（とくにプログラム）が入っていれば拒否します。

**拡張機能は SKILL.md だけで書きます**（仕様書 第12.12節、ADR-0029。`extensions/skill.ts`）。
`buildSkillPackage()` がスキル（Claude Code の Skills・Agent Skills）の項目をスキルと同じ意味で読み、
マニフェストとエージェント定義を組み立てて同じ検証に回します。`name`（省けばフォルダ名。`SKILL_FOLDER_ENTRY`）・`description`＋`when_to_use`（秘書の取り次ぎ）・
`argument-hint`・`arguments`（入力の欄）・`disable-model-invocation`（`secretaryRoute: false`）・`user-invocable: false`（`menu: false`）・`effort`（`tier`）・
`allowed-tools`（M2Office のツールと、同じフォルダの `connectors/*.json` で宣言したコネクタのツール。無いツールは無視して `notices`）。本文の `$ARGUMENTS`・`$N`・`$名前` は、実行エンジンが実行のときに入力で置き換えます（`substituteArguments()`）。
段は本文を指示にした 1 つで、送るツールがあれば「作業 → 承認 → 送る」を組みます。`HELP.md` は業務の説明の本文（`help.body`）になります。
補助のファイル（Markdown・テキスト）は定義の `skill.files` に入れ、推論がツール `skill.read` で必要なときに開きます。
`scripts/` などのプログラムと画像は除き、本文の `` !`コマンド` `` は消します（`notices` で知らせ、保存もしない）。
フロントマターは依存を足さず、YAML の基本の形だけを読みます（`parseSkill()`）。SKILL.md 1 つのファイルも取り込めます。
JSON の定義（`manifest.json`＋`agents/*.json`）は第 0.131.0 版で廃止し、`loadExtensionFiles()` は `JSON_FORMAT_RETIRED` を返して断ります。組み立てた後の形の検証の規則は `loadCompiledExtension()`（単体テスト用）で確かめます。

`ExtensionHub.forTenant()` は、公式の配布元の拡張機能と、その会社がファイルから取り込んだもの（自社専用）を合わせ、
**導入済み・有効・再同意が不要**なものだけを使える業務エージェントとツールにします。
返す `registry` には、会社の接続（`tenant_connections`。仕様書 第12.11節、ADR-0037）のツール（`<接続の ID>.<ツールの名前>`）が加わります。
接続は拡張機能とは別に会社が持つもので、有効な拡張機能に同梱の接続が未登録なら自動で登録し、拡張機能を消しても残します。
業務が使うツールが会社の接続に無ければ、その業務は使えません（`missingToolsOf()`）。秘書の調べもの（`secretary-lookup`）には、会社の接続の読むだけのツールが加わります。
SKILL.md で同梱していない接続のツールを `allowed-tools` に書くと、取り込むときは仮のツール（`connectionPlaceholder()`）で検証し、承認の段のあとでも使えるように組み立てます。
実行エンジンとワーカーは、この会社ごとの見え方で定義とツールを引きます。

コネクタのツールは `HttpMcpClient` で MCP サーバ（Streamable HTTP）の `tools/call` を呼びます。
応答は外部のデータとして印を付けて返し、失敗は「取得できませんでした」として返します（第12.11.3節）。
作り方は開発者マニュアル（`docs/developer/`）を参照してください。

### 利用範囲（グループ）

業務ごとに「誰が使えるか」を会社の設定の区分 `access` に持ちます（仕様書 第16.7節）。
判定は `@m2office/shared` の `canUseAgent()` で、対象は公式の業務エージェントの ID か拡張機能の ID です（`scopeTargetOf()`）。
画面・API での絞り込みに加え、`RunEngine` は実行を進める時点で、`Scheduler` は定時実行を起動する時点で、
依頼者が範囲の中かを自分で確かめます。依存の渡し忘れで素通りしないようにするためです。
権限区画に属する業務（定義の `compartment`）は、区画に入れる人だけが実行できます（`canRunAgent()`）。
区画に入れる人は、個別の割当と、区画に割り当てたグループの所属者です（`listUserCompartments()`）。

### 定時実行（`Scheduler`）

ワーカーから定期的に `tick()` を呼びます。時刻を過ぎた定時実行を見つけ、
通常と同じ待ち行列へ入れます。規則は「毎日」「毎週」で、利用者の地域の壁時計で解釈します。
ワーカーが止まっていた間に過ぎた回は、まとめて 1 回だけ起動します。

### 秘書（`Secretary`）

依頼を 3 層に振り分けます（仕様書 第10.9節）。

| 層 | 処理 | LLM |
|---|---|---|
| 1 | 定型の照会をデータから直接返す | 使わない |
| 2 | 高速モデルで業務エージェントへ取り次ぐ | 判定のみ |
| 3 | 完全な対話 | 標準モデル |

層 1 は推論を通らないため、事実の誤りが混入しません。
層 1 の照会は、承認待ち・予定（今日／明日／今週／次の予定）・未読メール・今日のタスク・実行状況です。
「メールの返信を下書きして」のような**作業の依頼**は、語句が当たっても層 1 では答えず取り次ぎます。

### LLM 抽象化層

モデル名を直接指定せず、「高速 / 標準 / 高性能」の役割で参照します。
共通形式は OpenAI 互換を土台とします（仕様書 第20.2節）。

## テスト

```bash
npm run typecheck
npm test --prefix ../..          # 単体テスト（承認ゲート、通知の宛先、定時実行の時刻など）
node ../../scripts/smoke.mjs     # API とワーカーを起動した状態で
```

## 関連文書

- 仕様書 第9章 エージェント基盤
- 仕様書 第10章 秘書エージェント
- 仕様書 第20.2節 LLM 抽象化層
