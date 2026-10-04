-- Web の分析（内蔵の拡張。仕様書 第34章・第34.18節）
-- 1. 会社の設定の区分（入り切り・担当の許可・選んだプロパティとサイト）
alter table tenant_settings add column if not exists web_review jsonb;

-- 2. 担当の Google アカウントの許可（アナリティクスと Search Console の読み取りだけ）を、会社の鍵の置き場に預ける
alter table tenant_credentials drop constraint if exists tenant_credentials_kind_check;
alter table tenant_credentials add constraint tenant_credentials_kind_check check (kind in ('gemini', 'google_oauth', 'wordpress', 'inquiry_mailbox', 'line', 'places', 'web_review'));

-- 3. 月の便り（月ごとに 1 つ）。数字はプログラムが API の値から計算したもの、文は推論が書いたもの
create table if not exists web_review_reports (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  month       text not null,
  figures     jsonb not null default '{}',
  summary     text not null default '',
  good        text not null default '',
  concern     text not null default '',
  next        text[] not null default '{}',
  created_at  timestamptz not null default now(),
  unique (tenant_id, month)
);
create index if not exists web_review_reports_tenant on web_review_reports (tenant_id, month desc);

alter table web_review_reports enable row level security;
drop policy if exists tenant_isolation on web_review_reports;
create policy tenant_isolation on web_review_reports
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on web_review_reports to m2office_app;
