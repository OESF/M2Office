-- 補助金・助成金の案内（内蔵の拡張。仕様書 第39章）。
-- 会社に合いそうな制度の候補を持つ。同じ制度は見分けの鍵で 1 件にし、見送りにした制度は出し直さない（第39.5節）。

alter table tenant_settings add column if not exists subsidies jsonb;

create table if not exists subsidy_candidates (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  key           text not null,
  name          text not null,
  provider      text not null default '',
  kind          text not null default 'subsidy' check (kind in ('subsidy', 'grant')),
  fit           text not null default 'check' check (fit in ('likely', 'check')),
  reason        text not null default '',
  conditions    text not null default '',
  amount        text not null default '',
  rate          text not null default '',
  start_on      date,
  deadline      date,
  source_title  text not null default '',
  source_url    text not null default '',
  origin        text not null default 'web' check (origin in ('jgrants', 'web')),
  status        text not null default 'new' check (status in ('new', 'interested', 'skipped')),
  status_by     text,
  digest        text not null default '',
  notified      text[] not null default '{}',
  found_at      timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, key)
);
create index if not exists subsidy_candidates_tenant on subsidy_candidates (tenant_id, status, deadline);

alter table subsidy_candidates enable row level security;
drop policy if exists tenant_isolation on subsidy_candidates;
create policy tenant_isolation on subsidy_candidates
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on subsidy_candidates to m2office_app;
