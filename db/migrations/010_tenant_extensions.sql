-- 会社ごとの拡張機能の導入（仕様書 第12.9.3節、不変則 I-8）
-- 導入の時点で同意した権限を記録する。権限が増える更新では再同意が要る（第12.6節）。
create table if not exists tenant_extensions (
  tenant_id              text not null references tenants(id) on delete cascade,
  extension_id           text not null,
  version                text not null,
  consented_permissions  jsonb not null,
  installed_by           text not null,
  installed_at           timestamptz not null default now(),
  primary key (tenant_id, extension_id)
);

alter table tenant_extensions enable row level security;
drop policy if exists tenant_isolation on tenant_extensions;
create policy tenant_isolation on tenant_extensions
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on tenant_extensions to m2office_app;
