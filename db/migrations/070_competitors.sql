-- 競合の分析（内蔵の拡張。仕様書 第36章・第36.18節）
-- 1. 会社の設定の区分（入り切り・商圏の上書き）
alter table tenant_settings add column if not exists competitors jsonb;

-- 2. 自社の像（会社に 1 つ）。会社の非公開の知識は使わず、自社の Web サイトと会社情報からまとめる
create table if not exists competitor_profiles (
  tenant_id     text primary key references tenants(id) on delete cascade,
  profile       jsonb not null,
  updated_at    timestamptz not null default now()
);

-- 3. 競合。地図（Places API）で見つけたものは place ID だけを残し、名前・URL は残さない（引き直す。第36.13節）
--    緯度と経度は 30 日まで（location_at から 30 日を過ぎたら使わず、消す）
create table if not exists competitors (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  origin        text not null check (origin in ('map', 'ai', 'manual')),
  place_id      text,
  name          text not null default '',
  url           text not null default '',
  lat           double precision,
  lng           double precision,
  location_at   timestamptz,
  reason        text not null default '',
  status        text not null default 'watching' check (status in ('watching', 'removed')),
  last_read_at  timestamptz,
  pages_read    integer not null default 0,
  pages_failed  integer not null default 0,
  read_note     text not null default '',
  created_by    text not null,
  created_at    timestamptz not null default now(),
  -- 地図で見つけたものは place ID が要り、名前・URL を持たない
  check ((origin = 'map' and place_id is not null and name = '' and url = '') or (origin <> 'map'))
);
create unique index if not exists competitors_place on competitors (tenant_id, place_id) where place_id is not null;
create index if not exists competitors_tenant on competitors (tenant_id, status);

-- 4. 取り出した事実。相手の文章は残さず、事実（短い文）と出典の URL・ページの印だけ（第36.7節）
create table if not exists competitor_facts (
  id             text primary key,
  tenant_id      text not null references tenants(id) on delete cascade,
  -- 競合（自社なら空）
  competitor_id  text references competitors(id) on delete cascade,
  period         text not null check (period ~ '^\d{4}-\d{2}$'),
  kind           text not null check (kind in ('service', 'campaign', 'news', 'hours', 'coverage', 'strength')),
  text           text not null,
  source_url     text not null,
  page_hash      text not null default '',
  created_at     timestamptz not null default now()
);
create index if not exists competitor_facts_by on competitor_facts (tenant_id, competitor_id, period);

-- 5. レポート（社内向け）
create table if not exists competitor_reports (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  period        text not null check (period ~ '^\d{4}-\d{2}$'),
  text          text not null,
  changes       integer not null default 0,
  created_by    text not null,
  created_at    timestamptz not null default now()
);
create index if not exists competitor_reports_tenant on competitor_reports (tenant_id, created_at desc);

-- 6. 後ろで行う作業（探す・読む）。ワーカーが 1 つずつ行う
create table if not exists competitor_jobs (
  id             text primary key,
  tenant_id      text not null references tenants(id) on delete cascade,
  kind           text not null check (kind in ('discover', 'check')),
  args           jsonb not null default '{}',
  status         text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  message        text not null default '',
  requested_by   text not null,
  created_at     timestamptz not null default now(),
  started_at     timestamptz,
  finished_at    timestamptz
);
create index if not exists competitor_jobs_queue on competitor_jobs (tenant_id, status, created_at);

do $$
declare t text;
begin
  foreach t in array array['competitor_profiles', 'competitors', 'competitor_facts', 'competitor_reports', 'competitor_jobs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
  end loop;
end $$;
grant select, insert, update, delete on competitor_profiles, competitors, competitor_facts, competitor_reports, competitor_jobs to m2office_app;
