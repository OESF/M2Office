-- Chat への通知の控えの本物の送信口（仕様書 第6.5.5.2.1節。第 0.376.0 版。ADR-0102）
--
-- ① 会社の Chat アプリのサービスアカウントの鍵を、会社の接続の設定（暗号化した秘密の値）として預かる（kind に google_chat_app を足す）。
-- ② 本人と Chat アプリの個別メッセージの場所（spaces/…）を覚えておく。名前だけで、メッセージの中身は持たない。
alter table tenant_credentials drop constraint if exists tenant_credentials_kind_check;
alter table tenant_credentials add constraint tenant_credentials_kind_check check (kind in ('gemini', 'google_oauth', 'wordpress', 'inquiry_mailbox', 'line', 'places', 'web_review', 'google_chat_app'));

create table if not exists chat_dm_spaces (
  tenant_id   text not null references tenants(id) on delete cascade,
  user_id     text not null,
  space       text not null check (space ~ '^spaces/[A-Za-z0-9_-]+$'),
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

alter table chat_dm_spaces enable row level security;
drop policy if exists tenant_isolation on chat_dm_spaces;
create policy tenant_isolation on chat_dm_spaces using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on chat_dm_spaces to m2office_app;
