-- コラムの作成の段 2（仕様書 第32.18.4節。第 0.248.0 版）
-- 1. テーマ案（週に 1 回。材料の印と「なぜ今か」つき）
create table if not exists web_column_themes (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  theme       text not null,
  why         text not null default '',
  source      text not null default 'topic' check (source in ('topic', 'season', 'search', 'competitor', 'question', 'rewrite')),
  column_id   text,
  status      text not null default 'new' check (status in ('new', 'used', 'dismissed')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists web_column_themes_tenant on web_column_themes (tenant_id, status, created_at desc);

alter table web_column_themes enable row level security;
drop policy if exists tenant_isolation on web_column_themes;
create policy tenant_isolation on web_column_themes
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on web_column_themes to m2office_app;

-- 2. 予定表の回・公開の日時（予約）と、状態に「予約」「取り下げ」を足す
alter table web_columns add column if not exists planned_for date;
alter table web_columns add column if not exists publish_at timestamptz;
alter table web_columns drop constraint if exists web_columns_status_check;
alter table web_columns add constraint web_columns_status_check
  check (status in ('writing', 'draft', 'awaiting', 'approved', 'scheduled', 'placed', 'withdrawn', 'failed'));
create index if not exists web_columns_due on web_columns (status, publish_at);

-- 3. 貼るだけのページは、ログインの無い人が鍵で読む。会社の境界を越えて鍵から会社を引くため、鍵で会社の ID だけを返す関数にする
create or replace function m2o_column_page(p_key text)
returns text
language sql stable security definer set search_path = public as $$
  select tenant_id from tenant_settings
   where web_columns->'pastePage'->>'key' = p_key and coalesce((web_columns->>'enabled')::boolean, false)
   limit 1
$$;
grant execute on function m2o_column_page(text) to m2office_app;
