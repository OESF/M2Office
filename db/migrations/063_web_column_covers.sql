-- Web のコラムのカバー画像（仕様書 第32.7.1節・第32.18.2節、ADR-0065）
-- 1. 版のカバー（ファイル・背景の種類・模様・代わりの文・AI の挿絵を描いた枚数・確かめの結果）。無ければ null
alter table web_column_versions add column if not exists cover jsonb;

-- 2. 会社の写真の置き場。コラムの画面の「写真を入れる」で入れ、推論が記事に合うものを選ぶ。説明と人が写っているかは入れたときに推論が読む
create table if not exists web_column_photos (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  file_id      text not null,
  description  text not null default '',
  has_people   boolean not null default false,
  created_by   text not null,
  created_at   timestamptz not null default now()
);
create index if not exists web_column_photos_tenant on web_column_photos (tenant_id, created_at desc);

-- 3. AI の挿絵の月の上限を数えるため、版の作った日で引く
create index if not exists web_column_versions_tenant_created on web_column_versions (tenant_id, created_at);

do $$
begin
  execute 'alter table web_column_photos enable row level security';
  execute 'drop policy if exists tenant_isolation on web_column_photos';
  execute 'create policy tenant_isolation on web_column_photos using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())';
end $$;
grant select, insert, update, delete on web_column_photos to m2office_app;
