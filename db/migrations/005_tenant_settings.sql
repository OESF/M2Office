-- 会社ごとの設定（仕様書 第6.6節、第9.4節、第15.2.1節）
-- 項目の追加が多い段階のため、区分ごとに jsonb で持つ。未保存の区分は既定値を使う。
create table if not exists tenant_settings (
  tenant_id      text primary key references tenants(id) on delete cascade,
  company        jsonb,
  writing_style  jsonb,
  automation     jsonb,
  agents         jsonb,
  updated_by     text,
  updated_at     timestamptz not null default now()
);

alter table tenant_settings enable row level security;
drop policy if exists tenant_isolation on tenant_settings;
create policy tenant_isolation on tenant_settings
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update on tenant_settings to m2office_app;

