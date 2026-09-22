-- 本人が編集する設定（仕様書 第6.5節）
create table if not exists user_settings (
  tenant_id      text not null references tenants(id) on delete cascade,
  user_id        text not null references users(id) on delete cascade,
  profile        jsonb,
  secretary      jsonb,
  notifications  jsonb,
  menu           jsonb,
  updated_at     timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

alter table user_settings enable row level security;
drop policy if exists tenant_isolation on user_settings;
create policy tenant_isolation on user_settings
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update on user_settings to m2office_app;
