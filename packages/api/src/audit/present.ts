/**
 * @file 監査ログを、管理者が読める言葉にする（仕様書 第6.6.8.1節）。誰が（人の名前・指示した人）、何をしたか（業務の言葉）、何に対して（名前）。
 *
 * 記録そのものは書き換えない。見せるときに言葉を足すだけで、記録の名前と値も並べて返す。
 * 引けない名前は推測で作らず、記録の値のまま出す。
 */

import { agentDisplayName, type AuditEvent } from '@m2office/shared';

/** 操作の名前を業務の言葉にする。無い名前は記録の名前のまま出す。 */
const ACTION_LABELS: Record<string, string> = {
  'auth.login': 'ログインした',
  'auth.login.denied': 'ログインを断られた',
  'auth.logout': 'ログアウトした',
  'auth.revoke': 'ログイン中の端末を切った',
  'approval.decide': '承認・却下した',
  'approval.auto': '承認が自動で通過した',
  'job.create': '業務を依頼した',
  'run.complete': '業務が完了した',
  'run.fail': '業務が失敗した',
  'run.dismiss_failure': '失敗した業務を確認した',
  'run.cancel': '業務を止めた',
  'run.expire': '承認待ちの業務を期限切れにした',
  'run.await_approval': '業務が承認待ちになった',
  'run.awaiting_approval': '業務が承認待ちになった',
  'run.await_confirmation': '業務が操作の確認待ちになった',
  'run.finished': '業務が終わった',
  'tool.invoke': '業務がツールを使った',
  'tool.blocked': '承認の前の送信を止めた',
  'secretary.chat': '秘書と話した',
  'secretary.direct': '秘書が定型の照会に答えた',
  'secretary.route': '秘書が業務に取り次いだ',
  'secretary.delegate': '秘書が業務に頼んだ',
  'secretary.lookup': '秘書が調べものを起こした',
  'secretary.promise': '秘書が約束した調べものを起こした',
  'secretary.file': '秘書にファイルを渡した',
  'secretary.help': '秘書がヘルプで答えた',
  'help.note.set': 'ヘルプに会社の補足を書いた',
  'help.note.remove': 'ヘルプの会社の補足を消した',
  'secretary.todo': '秘書が ToDo を受けた',
  'secretary.correct': '秘書の覚えたことを直した',
  'secretary.schedule': '秘書が定時実行を操作した',
  'secretary.brief': '秘書が朝のブリーフの中身を直した',
  'secretary.notice': '秘書が社内のお知らせを扱った',
  'secretary.launcher': '秘書がアプリの一覧を直した',
  'secretary.inventory': '秘書が在庫の問いに答えた',
  'secretary.reservation': '秘書が予約を扱った',
  'secretary.voice': '秘書と音声で話した',
  'secretary.plan.create': '秘書が段取りを組んだ',
  'secretary.plan.step': '段取りの業務を起こした',
  'secretary.plan.report': '段取りをまとめて報告した',
  'secretary.plan.cancel': '段取りを取りやめた',
  'secretary.plan.answer': '段取りの問いに答えた',
  'connection.google.connect': 'Google と接続した',
  'connection.google.disconnect': 'Google との接続を取り消した',
  'connection.google.lost': 'Google の側で許可が外されたため接続を消した',
  'connection.google.update': 'Google の接続の設定を変えた',
  'connection.google.picker': 'ドライブの写真を選ぶ画面の API キーを登録した',
  'connection.google.picker_delete': 'ドライブの写真を選ぶ画面の API キーを消した',
  'connection.google.update_rejected': 'Google の接続の設定が確かめで断られた',
  'connection.google.delete': 'Google の接続の設定を消した',
  'connection.gemini.update': 'Gemini の設定を変えた',
  'connection.gemini.delete_key': 'Gemini の鍵を消した',
  'connection.mcp.create': 'コネクタを登録した',
  'connection.mcp.update': 'コネクタの危険度などを変えた',
  'connection.mcp.refresh': 'コネクタのツールを取り直した',
  'connection.mcp.delete': 'コネクタを消した',
  'connection.mcp.tool.toggle': 'コネクタのツールを入り切りした',
  'connection.secret.update': '接続の鍵・シークレットを登録した',
  'connection.oauth.connect': 'サービスと接続した',
  'connection.oauth.disconnect': 'サービスとの接続を取り消した',
  'connection.oauth.lost': 'サービスとの接続が切れた',
  'connection.oauth.register': '接続のアプリを自動で登録した',
  'contact.update_from_signature': 'メールの署名から名刺を新しくした',
  'bulk_mail.start': 'まとめてのメールを送り始めた',
  'bulk_mail.done': 'まとめてのメールを送り終えた',
  'mail.opt_out': 'まとめてのメールの配信の停止を受けた',
  'mail.opt_out.remove': 'まとめてのメールの配信の停止を外した',
  'contact.signature_revert': 'メールの署名からの変更を戻した',
  'contact.signature_forget': 'メールの署名からの変更を削除した',
  'connection.oauth.register_reset': '無効になった接続のアプリを外した',
  'extension.import': '拡張機能を取り込んだ',
  'extension.install': '拡張機能を導入した',
  'extension.uninstall': '拡張機能を削除した',
  'extension.enable': '拡張機能を有効にした',
  'extension.disable': '拡張機能を無効にした',
  'extension.tool.toggle': 'ツールを入り切りした',
  'user.invite': '利用者を招待した',
  'user.update': '利用者の役割・状態を変えた',
  'group.create': 'グループを作った',
  'group.update': 'グループを変えた',
  'group.chat_space': 'グループに合う Chat のスペースを覚え直した',
  'group.delete': 'グループを消した',
  'group.members': 'グループの所属を変えた',
  'compartment.create': '権限区画を作った',
  'compartment.delete': '権限区画を消した',
  'compartment.assign': '権限区画に割り当てた',
  'compartment.enable': '権限区画を有効にした',
  'compartment.disable': '権限区画を無効にした',
  'compartment.enter': '権限区画のデータを見た',
  'compartment.leave': '権限区画から外れた',
  'settings.update': '会社の設定を変えた',
  'me.settings.update': '個人設定を変えた',
  'me.profile.update': '表示名を変えた',
  'onboarding.notified': 'はじめの設定を知らせた',
  'knowledge.save': '知識を登録した',
  'knowledge.delete': '知識を消した',
  'knowledge.correct': '知識を直した',
  'knowledge.register': '業務が知識に登録した',
  'knowledge.promote.auto': '秘書が覚えたことを会社の知識にした',
  'knowledge.rule.create': '社内規程を登録した',
  'knowledge.rule.revise': '社内規程を改定した',
  'knowledge.rule.retire': '社内規程を廃止した',
  'knowledge.rule.restore': '廃止した社内規程を戻した',
  'knowledge.minutes.retire': '議事録を廃止した',
  'knowledge.minutes.restore': '廃止した議事録を戻した',
  'knowledge.restore': 'しまった知識を戻した',
  'knowledge.consolidate': '秘書が学んだことを整理した',
  'memory.consolidate': '秘書が覚えたことを整理した',
  'memory.restore': 'しまった記憶を戻した',
  'hr.rule_check.dismiss': '規程の改定による設定の食い違いを見終えた',
  'memory.create': '覚えることを登録した',
  'memory.update': '覚えたことを直した',
  'memory.delete': '覚えたことを消した',
  'memory.clear': '覚えたことをすべて消した',
  'memory.learn': '秘書が会話から学んだ',
  'conversation.clear': '会話ログをすべて消した',
  'conversation.delete': '会話ログを消した',
  'schedule.create': '定時実行を登録した',
  'schedule.update': '定時実行を変えた',
  'schedule.delete': '定時実行を消した',
  'schedule.trigger': '定時実行を今すぐ動かした',
  'schedule.skip': '定時実行を飛ばした',
  'file.upload': 'ファイルを上げた',
  'notification.deliver': '通知を届けた',
  'audit.export': '監査ログを出力した',
  // 名刺管理（仕様書 第27.10節。見ただけでは残さない）
  'card.import': '名刺を取り込んだ',
  'contact.merge': '同じ人の名刺をまとめた',
  'contact.split': 'まとめた名刺を分けた',
  'contact.scope': '名刺の範囲を変えた',
  'contact.trash': '名刺をごみ箱へ移した',
  'contact.restore': '名刺をごみ箱から戻した',
  'contact.purge': '名刺を消去した',
  // 社内のお知らせ（仕様書 第10.15節）
  'notice.create': '社内のお知らせを出した',
  'notice.withdraw': '社内のお知らせを取り下げた',
  // 在庫管理（仕様書 第29.16節。入出庫の 1 件ずつは記録そのものに残るため入れない）
  'inventory.import': '在庫の品目を取り込んだ',
  'inventory.export': '在庫を書き出した',
  'inventory.adjust': '在庫を調整した',
  'inventory.item.stop': '在庫の品目を止めた',
  'inventory.publication.approve': '在庫の Web への公開を承認した',
  'inventory.publication.stop': '在庫の Web への公開を止めた',
  'inventory.publication.delete': '在庫の Web への公開を削除した',
  'inventory.item.resume': '在庫の品目を使うに戻した',
  'inventory.location.remove': '在庫の場所を外した',
  'inventory.count.start': '棚卸しを始めた',
  'inventory.count.close': '棚卸しを確定した',
  'inventory.count.cancel': '棚卸しをやめた',
  'inventory.booking_source.create': '予約の受け口を作った',
  'inventory.booking_source.stop': '予約の受け口を止めた',
  'inventory.booking_source.resume': '予約の受け口を動かした',
  'inventory.booking_source.mapping': '予約の受け口の型を直した',
  'inventory.menu.teach': '予約のメニューで使う品目を覚えさせた',
  // 店頭サイネージ（仕様書 第31.12.1節。割り込みの 1 件ずつは入れない）
  'signage.screen.register': 'サイネージの画面を登録した',
  'signage.screen.remove': 'サイネージの画面を外した',
  'signage.screen.update': 'サイネージの画面を直した',
  'signage.flow.update': 'サイネージの流れを直した',
  'signage.band.create': 'サイネージの時間帯を足した',
  'signage.band.update': 'サイネージの時間帯を直した',
  'signage.band.delete': 'サイネージの時間帯を削除した',
  'signage.asset.add': 'サイネージの素材を足した',
  'signage.asset.remove': 'サイネージの素材を消した',
  'signage.interrupt_asset.set': 'サイネージの割り込みの素材を変えた',
  'machine.backup_request': '機械の控えを今すぐ取るよう頼んだ',
  'signage.asset.ai_name': 'サイネージの割り込みの素材に AI が名前を付けた',
  'signage.source.create': 'サイネージの呼び出しの受け口を作った',
  'signage.source.stop': 'サイネージの呼び出しの受け口を止めた',
  'signage.source.resume': 'サイネージの呼び出しの受け口を動かした',
  'signage.source.reset_mapping': 'サイネージの呼び出しの受け口を推測し直した',
  'signage.sound.add': 'サイネージのジングルの音を入れた',
  'signage.sound.remove': 'サイネージのジングルの音を消した',
  // Web のコラム（仕様書 第32.18.1節）
  'column.create': 'コラムを書き始めた',
  'column.submit': 'コラムを承認へ進めた',
  'column.approve': 'コラムを承認した',
  'column.place': 'コラムを WordPress に入れた',
  'column.schedule': 'コラムを予約にした',
  'column.publish_at': 'コラムの公開の日時を変えた',
  'column.withdraw': 'コラムを取り下げた',
  'column.signage_make': 'コラムからサイネージの画面用の画像を作り始めた',
  'column.signage_submit': 'サイネージの画面用の画像を承認へ進めた',
  'column.signage_publish': 'サイネージの画面用の画像を流した',
  'column.signage_withdraw': 'サイネージの画面用の画像を外した',
  'column.themes': 'コラムのテーマ案を作った',
  'column.theme_use': 'テーマ案からコラムを書き始めた',
  'column.theme_dismiss': 'コラムのテーマ案を見送りにした',
  'column.prepare': '予定表の回のコラムを先回りで書き始めた',
  'column.skip': '承認されなかったコラムの回を飛ばした',
  'column.page_enable': 'コラムの貼るだけのページを入れた',
  'column.page_disable': 'コラムの貼るだけのページを止めた',
  'column.delete': 'コラムを削除した',
  'column.photo_add': 'コラムの写真を入れた',
  'column.rules': 'コラムの表現の決まりを選んだ',
  'column.wordpress_save': 'コラムの WordPress の鍵を預けた',
  'column.wordpress_remove': 'コラムの WordPress の鍵を外した',
  // 問い合わせの記録（仕様書 第33.17節。お客様の名前と用件は記録に残さない）
  'announcement.draft': 'お知らせの下書きを作った',
  'announcement.revise': 'お知らせを直した',
  'announcement.submit': 'お知らせを承認へ進めた',
  'announcement.approve': 'お知らせが承認された',
  'announcement.schedule': 'お知らせを予約した',
  'announcement.publish': 'お知らせを出した',
  'announcement.web': 'お知らせを Web サイトに出した',
  'announcement.line': 'お知らせを LINE で一斉配信した',
  'announcement.signage': 'お知らせをサイネージの画面に流した',
  'announcement.cancel': 'お知らせの予約を取り消した',
  'announcement.end': 'お知らせの期間の後を片付けた',
  'announcement.remove': 'お知らせを削除した',
  'announcement.mail': 'お知らせをメールで送り始めた',
  'announcement.closure': '休業の期間を覚えた',
  'inquiry.closure_reply': '休業中の問い合わせに返事の下書きを用意した',
  // 契約の管理（仕様書 第38章。相手の名前と契約の中身は記録に残さない）
  'contract.create': '契約を台帳に入れた',
  'contract.update': '契約の台帳を直した',
  'contract.status': '契約の状態を変えた',
  'contract.delete': '契約を台帳から削除した',
  'contract.open': '契約書を開いた',
  'contract.storage': '契約書の置き場をつないだ',
  'contract.renewed': '契約を自動で次の期間に進めた',
  'contract.review': '契約書チェックで見直しを始めた',
  'reservation.item.create': '予約できるものを足した',
  'reservation.item.update': '予約できるものを直した',
  'reservation.item.stop': '予約できるものを止めた',
  'reservation.admin_change': 'ほかの人の予約を管理者が変えた・取り消した',
  'subsidy.search': '補助金・助成金を調べた',
  'member.settings': '会員とポイントの設定を直した',
  'member.undo': '会員のポイントの前の日の記録を取り消した',
  'member.merge': '会員をまとめた',
  'member.delete': '会員を削除した',
  'member.reward.create': '会員の特典を作った',
  'member.reward.update': '会員の特典を直した',
  'member.line.submit': '会員への LINE の知らせを承認へ進めた',
  'member.line.send': '会員に LINE で知らせた',
  'print.create': '販促物の案を作った',
  'print.choose': '販促物の案を選んだ',
  'print.revise': '販促物を直した',
  'print.remake': '販促物を作り直した',
  'print.delete': '販促物を削除した',
  'print.signage': '販促物を店頭サイネージに流した',
  'print.signage.stop': '販促物を店頭サイネージから外した',
  'print.announce': '販促物からお知らせの下書きを作った',
  'print.canva.open': '販促物を Canva に取り込んだ',
  'print.canva.pull': 'Canva で直した販促物を取り込んだ',
  'canva.connect': 'Canva と接続した',
  'canva.disconnect': 'Canva との接続を切断した',
  'print.export': '販促物を書き出した',
  'subsidy.status': '補助金・助成金の候補の状態を変えた',
  'subsidy.settings': '補助金・助成金の会社の関心と業種を直した',
  'web_review.connect': 'Webの分析の担当の Google の許可をつないだ',
  'web_review.disconnect': 'Webの分析の担当の Google の許可を外した',
  'web_review.select': 'Webの分析で見るプロパティとサイトを選んだ',
  'web_review.report': 'Web の月の便りを作った',
  'web_review.check': 'Web の直すべき所を探した',
  'web_review.finding': 'Web の直すべき所の状態を変えた',
  'web_review.request_submit': '制作会社への依頼文を承認へ進めた',
  'web_review.request_send': '制作会社に依頼文を送った',
  'inquiry.knowledge': '問い合わせの返事から会社の知識を登録した',
  'competitor.add': '競合を入れた',
  'competitor.remove': '競合を外した',
  'competitor.discover': '競合を探した',
  'competitor.check': '競合のサイトを読んだ',
  'competitor.report': '競合のレポートを作った',
  'competitor.settings': '競合の分析の設定を変えた',
  'competitor.map_key_set': '競合の分析の地図の鍵を預けた',
  'competitor.map_key_remove': '競合の分析の地図の鍵を外した',
  'inquiry.create': '問い合わせを残した',
  'inquiry.append': '問い合わせに続きを足した',
  'inquiry.update': '問い合わせを直した',
  'inquiry.task_add': '問い合わせの次にやることを足した',
  'inquiry.task_update': '問い合わせの次にやることを直した',
  'inquiry.task_done': '問い合わせの次にやることを済みにした',
  'inquiry.delete': '問い合わせを削除した',
  'inquiry.erase_person': '本人から求められて、その人の問い合わせをまとめて削除した',
  'inquiry.split': '問い合わせの履歴を別の問い合わせに分けた',
  'inquiry.mailbox_connect': '問い合わせの窓口のアカウントをつないだ',
  'inquiry.mailbox_disconnect': '問い合わせの窓口のアカウントを外した',
  'inquiry.mail_create': '窓口のメールから問い合わせを残した',
  'inquiry.mail_append': '窓口のメールを問い合わせに足した',
  'inquiry.mail_promote': '問い合わせでないとしたメールを問い合わせにした',
  'inquiry.reply_draft': '問い合わせの返事の下書きを書いた',
  'inquiry.reply_submit': '問い合わせの返事を承認へ進めた',
  'inquiry.reply_send': '問い合わせの返事を送った',
  'inquiry.line_connect': '問い合わせの LINE 公式アカウントをつないだ',
  'inquiry.line_disconnect': '問い合わせの LINE 公式アカウントを外した',
  'inquiry.line_create': 'LINE のメッセージから問い合わせを残した',
  'inquiry.line_append': 'LINE のメッセージを問い合わせに足した',
  // 人事・給与（仕様書 第30.21節。他人の台帳を見ただけでも残す）
  'hr.list': '従業員の一覧を見た',
  'hr.view': '従業員の台帳を見た',
  'hr.employee.create': '従業員を登録した',
  'hr.employee.update': '従業員の台帳を直した',
  'hr.employee.leave': '従業員の退職を記録した',
  'hr.terms.add': '雇用条件を足した',
  'hr.task.done': '入退社の手続きを済んだにした',
  'hr.task.reopen': '入退社の手続きを戻した',
  'hr.import': '従業員を取り込んだ',
  'hr.export': '人事・給与の帳簿を書き出した',
  'hr.employee.link': '従業員と利用者を結び付けた',
  'hr.attendance.view': '勤怠の一覧を見た',
  'hr.attendance.fix': '打刻を直した',
  'hr.attendance.close': '勤怠を締めた',
  'hr.attendance.reopen': '勤怠の締めを戻した',
  'hr.leave.take': '有給を記録した',
  'hr.leave.cancel': '有給を取り消した',
  'hr.leave.grant': '有給を付与した（手作業）',
  'hr.payroll.profile': '給与の情報を直した',
  'hr.payroll.standard': '標準報酬月額を足した',
  'hr.payroll.family': '家族を直した',
  'hr.payroll.calculate': '給与を計算した（下書き）',
  'hr.payroll.view': '給与の明細を見た',
  'hr.payroll.confirm': '給与を確定した（お金の確定）',
  'hr.notice': '労働条件通知書を作った',
  'hr.payroll.adjust': '給与の調整の行を直した',
  'hr.yea.declare': '年末調整の申告を残した',
  'hr.yea.check': '年末調整の申告を確かめた',
  'hr.yea.view': '年末調整の一覧を見た',
  'hr.yea.request': '年末調整の申告を頼んだ',
  'hr.yea.calculate': '年末調整を計算した',
  'hr.yea.withholding': '源泉徴収票を出した',
  'hr.yea.report': '源泉徴収票・給与支払報告書の下書きを書き出した',
  'hr.social.regular': '算定基礎届の下書きを作った（標準報酬月額を入れた）',
  'hr.social.change': '月額変更届の下書きを作った（標準報酬月額を入れた）',
  'hr.social.acquire': '資格取得届の下書きを作った（標準報酬月額を入れた）',
  'hr.social.lose': '資格喪失届の下書きを作った',
  'hr.social.age70': '70 歳到達届の下書きを作った',
  'hr.shift.settings': '勤務の型と要る人数を直した',
  'hr.shift.generate': 'シフトの案を作った',
  'hr.shift.set': 'シフトを直した',
  'hr.shift.publish': 'シフトを公開した',
  'hr.books.export': '人事・給与の帳簿をまとめて書き出した',
  'hr.labor.save': '年度更新の足りない月・申告済の概算保険料を入れた',
  'hr.labor.report': '労働保険の年度更新の下書きを作った',
  'hr.payroll.bonus-report': '賞与支払届の下書きを出した',
  'hr.payroll.correction': '給与の訂正の回を作った',
  'hr.proposal': '規程から人事・給与の設定の案を作った',
  'hr.payroll.request': '管理者に給与の確定を頼んだ',
  'hr.payroll.transfer': '振込データを作った（お金の確定）',
  'hr.payroll.pdf': '給与明細の PDF を出した',
  'hr.payroll.ledger': '賃金台帳を書き出した',
  'hr.payroll.resident': '住民税の決定通知書を読み取った',
  'hr.payroll.trial': '試しの計算をした',
  'hr.payroll.self': '自分の給与明細を見た',
  'hr.payroll.consent': '給与明細を画面で受け取る同意を変えた',
  // 運営の操作（マスター管理画面。仕様書 第23.8.6節・第23.6.1節）
  'tenant.create': '会社を作った',
  'tenant.status': '試用と稼働を切り替えた',
  'tenant.suspend_requested': 'ご利用の停止が申請された',
  'tenant.suspend_scheduled': 'ご利用の停止を予告した',
  'tenant.suspend': 'ご利用を停止した',
  'tenant.lock': 'ご利用を緊急停止した',
  'tenant.lock_confirmed': '緊急停止が確認された',
  'tenant.resume_requested': 'ご利用の再開が申請された',
  'tenant.resume': 'ご利用を再開した',
  'tenant.suspend_withdrawn': 'ご利用の停止の申請を取り下げた',
  'tenant.suspend_rejected': 'ご利用の停止が承認されなかった',
  'tenant.resume_withdrawn': 'ご利用の再開の申請を取り下げた',
  'tenant.resume_rejected': 'ご利用の再開が承認されなかった',
  'proxy.request': 'サポートが閲覧を申請した',
  'proxy.approve': 'サポートの閲覧を許した',
  'proxy.deny': 'サポートの閲覧を断った',
  'proxy.revoke': 'サポートの閲覧を切った',
  'proxy.enter': 'サポートが閲覧を始めた',
  'proxy.view': 'サポートが画面を見た',
  'proxy.end': 'サポートの閲覧を運営が終えた',
  'proxy.ended': 'サポートの閲覧が終わった',
};

/** 操作の種類（絞り込みの単位）。`prefixes` のどれかで始まる操作が当たる。 */
export const AUDIT_CATEGORIES: { id: string; label: string; prefixes: string[] }[] = [
  { id: 'login', label: 'ログイン', prefixes: ['auth.'] },
  { id: 'approval', label: '承認', prefixes: ['approval.'] },
  { id: 'run', label: '業務の実行', prefixes: ['job.', 'run.', 'tool.'] },
  { id: 'secretary', label: '秘書', prefixes: ['secretary.'] },
  { id: 'connection', label: '接続', prefixes: ['connection.'] },
  { id: 'extension', label: '拡張機能', prefixes: ['extension.'] },
  { id: 'users', label: 'ユーザーと権限', prefixes: ['user.', 'group.', 'compartment.'] },
  { id: 'settings', label: '設定', prefixes: ['settings.', 'me.', 'onboarding.'] },
  { id: 'knowledge', label: '知識と記憶', prefixes: ['knowledge.', 'memory.', 'conversation.'] },
  { id: 'schedule', label: '定時実行', prefixes: ['schedule.'] },
  { id: 'cards', label: '名刺', prefixes: ['card.', 'contact.'] },
  { id: 'notices', label: '社内のお知らせ', prefixes: ['notice.'] },
  { id: 'inventory', label: '在庫', prefixes: ['inventory.'] },
  { id: 'hr', label: '人事・給与', prefixes: ['hr.'] },
  { id: 'signage', label: 'サイネージ', prefixes: ['signage.'] },
];

/** 仕組みの名前（主体が `system` のとき）。 */
const SYSTEM_LABELS: Record<string, string> = {
  scheduler: '定時実行',
  engine: '業務の実行',
  learning: '秘書の学習',
  notifier: '通知',
  retention: 'データの保持期間の処理',
  revocation: '許可の取り消しの後始末',
  connection: '接続の見張り',
  conductor: '秘書の指揮',
  proactive: '秘書の先回り',
  worker: '業務の実行',
  onboarding: 'はじめの設定の案内',
  notify: '通知',
  cards: '名刺の読み取り',
};

/** 秘書の応答の層などの記録の値（`secretary.chat` の `full` など）。 */
const SECRETARY_TARGETS: Record<string, string> = { stock: '在庫の数', low: '残りわずかの品目', settings: '朝のブリーフの中身', create: 'お知らせを出す', withdraw: 'お知らせの取り下げ', list: 'お知らせの一覧', add: 'アプリの一覧に入れる', remove: 'アプリの一覧から削除', hide: 'Google のサービスを出さない', show: 'Google のサービスを出す', done: 'お知らせを済んだにする', ask: '聞き返し', full: '会話', direct: '定型の照会', light: '取次', start: '音声の始まり', end: '音声の終わり' };

/** 見せるための名前を引く口。引けなければ `undefined`（記録の値のまま出す）。 */
export interface AuditNames {
  user(id: string): string | undefined;
  agent(id: string): string | undefined;
  connection(id: string): string | undefined;
  group(id: string): string | undefined;
  compartment(id: string): string | undefined;
  /** 実行の業務の名前と依頼した人の ID。 */
  run(id: string): { agentName: string; requestedBy: string } | undefined;
}

/** 画面と CSV に出す 1 行。記録の名前と値も並べる。 */
export interface AuditRow {
  id: string;
  occurredAt: string;
  who: string;
  what: string;
  target: string;
  category: string;
  action: string;
  actor: string;
  targetRaw: string;
  detail: Record<string, unknown>;
  /** 記録の値そのもの（API を読む側が突き合わせに使う）。 */
  actorType: AuditEvent['actorType'];
  actorId: string;
  targetType: string;
  targetId: string;
}

/** 操作が属する種類。どれにも当たらなければ「その他」。 */
export function categoryOf(action: string): string {
  return AUDIT_CATEGORIES.find((c) => c.prefixes.some((p) => action.startsWith(p)))?.label ?? 'その他';
}

/**
 * 監査ログ 1 件を、誰が・何をしたか・何に対してに直す（仕様書 第6.6.8.1節）。
 *
 * @remarks 秘書と業務が行ったものは、指示した人を添える（第16.6節「本人を主体として記録する」）
 */
export function presentAudit(e: AuditEvent, names: AuditNames): AuditRow {
  const person = (id: string) => names.user(id) ?? id;
  const runId = typeof e.detail?.['runId'] === 'string' ? e.detail['runId'] : null;
  const run = runId ? names.run(runId) : undefined;
  const who = e.actorType === 'user' ? person(e.actorId)
    : e.actorType === 'secretary' ? `秘書（${person(e.actorId)}さんの依頼）`
    : e.actorType === 'agent' ? `業務「${names.agent(e.actorId) ?? run?.agentName ?? agentDisplayName(null, e.actorId)}」${run ? `（${person(run.requestedBy)}さんの依頼）` : ''}`
    : e.actorType === 'api_client' ? `外部アプリ（${e.actorId}）`
    // 運営の操作（`ops:<運営者>`）。運営者のメールアドレスが記録にあれば添える
    : e.actorId.startsWith('ops:') ? `運営${typeof e.detail?.['operator'] === 'string' ? `（${e.detail['operator']}）` : ''}`
    : `システム（${SYSTEM_LABELS[e.actorId] ?? e.actorId}）`;
  return {
    id: e.id, occurredAt: e.occurredAt, who, what: whatOf(e), target: targetOf(e, names), category: categoryOf(e.action),
    action: e.action, actor: `${e.actorType}: ${e.actorId}`, targetRaw: `${e.targetType}: ${e.targetId}`, detail: e.detail ?? {},
    actorType: e.actorType, actorId: e.actorId, targetType: e.targetType, targetId: e.targetId,
  };
}

/** 何をしたか。承認は承認か却下かまで言う。 */
function whatOf(e: AuditEvent): string {
  if (e.action === 'approval.decide') {
    const d = e.detail?.['decision'];
    if (d === 'approved') return '承認した';
    if (d === 'rejected') return '却下した';
  }
  return ACTION_LABELS[e.action] ?? e.action;
}

/** 何に対してか。分かるものは名前にする。 */
function targetOf(e: AuditEvent, names: AuditNames): string {
  const id = e.targetId;
  switch (e.targetType) {
    case 'user': return names.user(id) ?? id;
    case 'run': {
      const r = names.run(id);
      return r ? `業務「${r.agentName}」の実行` : `実行 ${id.slice(0, 8)}`;
    }
    case 'agent': return names.agent(id) ? `業務「${names.agent(id)}」` : id;
    case 'approval': {
      // 承認の記録は、どの業務の承認かを添える
      const runId = typeof e.detail?.['runId'] === 'string' ? e.detail['runId'] : '';
      const r = runId ? names.run(runId) : undefined;
      return r ? `業務「${r.agentName}」の承認` : `承認 ${id.slice(0, 8)}`;
    }
    case 'connection': return names.connection(id) ? `接続「${names.connection(id)}」` : id;
    case 'group': return names.group(id) ? `グループ「${names.group(id)}」` : id;
    case 'compartment': return names.compartment(id) ? `区画「${names.compartment(id)}」` : id;
    // 従業員の名前は監査ログの画面に出さない（人事区画の外の管理者も見るため）。台帳の ID の頭だけ
    case 'hr_employee': return `従業員 ${id.slice(0, 8)}`;
    // コラムの題名は出さない（テーマは記録の詳細にある）
    case 'web_column': return id.startsWith('col-') ? `コラム ${id.slice(4, 12)}` : 'コラムの作成の設定';
    // 問い合わせはお客様の名前を出さない。ID の頭だけ
    case 'announcement': return `お知らせ ${id.slice(4, 12)}`;
    // 契約は相手の名前を出さない。ID の頭だけ
    case 'contract': return id === 'storage' ? '契約書の置き場' : `契約 ${id.slice(4, 12)}`;
    case 'print-design': return `販促物 ${id.slice(4, 12)}`;
    case 'canva': return '本人の Canva';
    case 'member': return id === 'settings' ? '会員とポイントの設定' : id.startsWith('mrw-') ? `特典 ${id.slice(4, 12)}` : `会員 ${id.slice(4, 12)}`;
    case 'subsidy': return id === 'search' ? '補助金・助成金の調べもの' : id === 'settings' ? '補助金・助成金の設定' : `補助金・助成金の候補 ${id.slice(4, 12)}`;
    case 'reservation': return id.startsWith('rsi-') ? `予約できるもの ${id.slice(4, 12)}` : `予約 ${id.slice(4, 12)}`;
    case 'web_review': return 'Webの分析';
    case 'competitor': return id === 'settings' ? '競合の分析の設定' : id === 'map-key' ? '競合の分析の地図の鍵' : id === 'discover' ? '競合の分析（探す）' : id === 'all' ? '競合の分析（見回り）' : `競合の分析 ${id.slice(4, 12)}`;
    case 'inquiry': return id === 'mailbox' ? '問い合わせの窓口のアカウント' : id === 'line' ? '問い合わせの LINE 公式アカウント' : `問い合わせ ${id.slice(4, 12)}`;
    case 'tool': {
      // 会社の接続のツール（`slack.slack_send_message`）は接続の名前を添える
      const [head, ...rest] = id.split('.');
      const conn = head ? names.connection(head) : undefined;
      return conn && rest.length > 0 ? `${conn} のツール ${rest.join('.')}` : `ツール ${id}`;
    }
    case 'job': {
      // 依頼の記録は、根拠に業務の ID を持つ
      const agentId = typeof e.detail?.['agentId'] === 'string' ? e.detail['agentId'] : '';
      return agentId ? `業務「${names.agent(agentId) ?? agentId}」` : `依頼 ${id.slice(0, 8)}`;
    }
    // 秘書の記録の対象は、取り次いだ業務か、起こした実行か、応答の層
    case 'secretary': return names.agent(id) ? `業務「${names.agent(id)}」` : names.run(id) ? `業務「${names.run(id)!.agentName}」の実行` : (SECRETARY_TARGETS[id] ?? id);
    case 'session': return 'ログイン中の端末';
    case 'tenant': case 'tenant_settings': return '会社の設定';
    case 'user_settings': return '個人設定';
    case 'audit': return '監査ログ';
    case 'conversation': return '会話ログ';
    // 名刺の相手の名前は出さない。自分だけの名刺の相手を、管理者に知らせないため（第27.7節）
    case 'contact': case 'card': case 'card_batch': return '名刺';
    // お知らせは題名を添える（社内に出したものなので、管理者に見せてよい）
    case 'notice': return typeof e.detail?.['title'] === 'string' ? `お知らせ「${e.detail['title']}」` : 'お知らせ';
    default: return id ? `${id}` : '—';
  }
}

/** CSV の 1 項目。区切り・引用・改行を含む値を囲む。 */
function cell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * 監査ログを CSV にする（Excel で開けるよう BOM 付き）。列は日時・誰が・何をしたか・何に対して・種類・記録の名前・記録の値・詳細。
 */
export function auditCsv(rows: AuditRow[], timeZone = 'Asia/Tokyo'): string {
  const head = ['日時', '誰が', '何をしたか', '何に対して', '種類', '記録の名前', '記録の主体', '記録の対象', '詳細'];
  const fmt = new Intl.DateTimeFormat('ja-JP', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const lines = rows.map((r) => [
    fmt.format(new Date(r.occurredAt)), r.who, r.what, r.target, r.category, r.action, r.actor, r.targetRaw, JSON.stringify(r.detail),
  ].map(cell).join(','));
  return `﻿${[head.join(','), ...lines].join('\r\n')}\r\n`;
}
