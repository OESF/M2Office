-- AI の利用の記録と上限（仕様書 第6.6.2節「AI の利用の記録と上限」、ADR-0079。第 0.298.0 版）。
-- AI を呼ぶたびに 1 行（会社・利用者・用途・モデル・トークン・費用）。中身（プロンプトと答え）は持たない。
-- 上限の知らせを月に 1 度だけ送るため、送った印を持つ。

alter table tenant_settings add column if not exists ai_limits jsonb;

create table if not exists ai_usage (
  id             bigserial primary key,
  tenant_id      text not null references tenants(id) on delete cascade,
  user_id        text,
  purpose        text not null,
  model          text,
  input_tokens   integer not null default 0,
  output_tokens  integer not null default 0,
  units          real not null default 0,
  cost_jpy       numeric(14, 4) not null default 0,
  local          boolean not null default false,
  run_id         text,
  at             timestamptz not null default now()
);
create index if not exists ai_usage_tenant_at on ai_usage (tenant_id, at);
create index if not exists ai_usage_tenant_user_at on ai_usage (tenant_id, user_id, at);

alter table ai_usage enable row level security;
drop policy if exists tenant_isolation on ai_usage;
create policy tenant_isolation on ai_usage
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, delete on ai_usage to m2office_app;
grant usage, select on sequence ai_usage_id_seq to m2office_app;

create table if not exists ai_usage_alerts (
  tenant_id  text not null references tenants(id) on delete cascade,
  month      text not null,
  level      text not null,
  user_id    text not null default '',
  sent_at    timestamptz not null default now(),
  primary key (tenant_id, month, level, user_id)
);

alter table ai_usage_alerts enable row level security;
drop policy if exists tenant_isolation on ai_usage_alerts;
create policy tenant_isolation on ai_usage_alerts
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, delete on ai_usage_alerts to m2office_app;
