-- 不正の兆しの見張りの段 3: Google Workspace のログインの記録の取り込み（仕様書 第16.8.6節、ADR-0092）
--
-- 担当の管理者の Google の許可（読み取りだけ）を、会社の鍵の置き場の種類 google_login_audit に預ける。
-- 見張りの様子に、どこまで読んだか・読めなかった時刻・読めないことを知らせた日を足す。Google の記録そのもの（IP など）は写さない。
-- 巻き戻し: 列を落とし、鍵の置き場の種類の制約を移行 141 の形に戻す（google_login_audit の行を消してから）。

alter table security_watch_state add column if not exists google_read_at timestamptz;
alter table security_watch_state add column if not exists google_error_at timestamptz;
alter table security_watch_state add column if not exists google_error_notified_on text;

alter table tenant_credentials drop constraint if exists tenant_credentials_kind_check;
alter table tenant_credentials add constraint tenant_credentials_kind_check
  check (kind in ('gemini', 'google_oauth', 'wordpress', 'inquiry_mailbox', 'line', 'places', 'web_review', 'google_chat_app', 'google_login_audit'));
