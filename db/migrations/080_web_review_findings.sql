-- Web の分析の段 2: 直すべき所とページごとの数字（仕様書 第34.19節）
-- 1. 直すべき所。同じ種類・同じ対象は 1 つにまとめ、また見つかったら数字と案を新しくする
create table if not exists web_review_findings (
  id             text primary key,
  tenant_id      text not null references tenants(id) on delete cascade,
  kind           text not null check (kind in ('lowCtr', 'nearFirstPage', 'missingContent', 'notIndexed', 'slowMobile', 'fading')),
  target         text not null,
  title          text not null default '',
  figures        jsonb not null default '{}',
  advice         text not null default '',
  request_draft  jsonb,
  column_id      text,
  status         text not null default 'new' check (status in ('new', 'seen', 'done', 'dismissed')),
  found_at       timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, kind, target)
);
create index if not exists web_review_findings_tenant on web_review_findings (tenant_id, status, found_at desc);

-- 2. ページごとの数字（この 28 日の分を、見回りのたびに置き換える）。コラムの作成の web_column_metrics（第32.17節）はこの表で代える
create table if not exists web_page_metrics (
  tenant_id   text not null references tenants(id) on delete cascade,
  path        text not null,
  start_date  date not null,
  end_date    date not null,
  metrics     jsonb not null default '{}',
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, path)
);

do $$
declare t text;
begin
  foreach t in array array['web_review_findings', 'web_page_metrics'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
  end loop;
end $$;
grant select, insert, update, delete on web_review_findings, web_page_metrics to m2office_app;

-- 3. WordPress で公開されたコラムの URL（見回りのときに WordPress から読む）
alter table web_columns add column if not exists web_url text;
