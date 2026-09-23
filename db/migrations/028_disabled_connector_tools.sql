-- 管理者が個別に止めたコネクタのツール（仕様書 第6.6.3.1節）
--
-- 導入の同意で認めたツールは、すべて有効である。
-- ここに**止めたものだけ**を残す。行が無ければ有効であり、拡張機能に
-- ツールが増えても、勝手に止まることはない。
create table if not exists disabled_connector_tools (
  tenant_id     text not null references tenants(id) on delete cascade,
  connector_id  text not null,
  tool_name     text not null,
  disabled_by   text not null,
  disabled_at   timestamptz not null default now(),
  primary key (tenant_id, connector_id, tool_name)
);

alter table disabled_connector_tools enable row level security;
drop policy if exists tenant_isolation on disabled_connector_tools;
create policy tenant_isolation on disabled_connector_tools
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on disabled_connector_tools to m2office_app;
