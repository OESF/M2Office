-- 店頭サイネージの在庫の入荷と品切れの案内（仕様書 第31.6.7節。第 0.268.0 版）
-- 流している案内（品目の名前ごとに 1 つ。入荷は 3 日で、品切れは入荷したら外す）
create table if not exists signage_stock_notices (
  tenant_id   text not null references tenants(id) on delete cascade,
  item_name   text not null,
  kind        text not null check (kind in ('back', 'out')),
  asset_id    text not null references signage_assets(id) on delete cascade,
  expires_at  timestamptz,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, item_name)
);

alter table signage_stock_notices enable row level security;
drop policy if exists tenant_isolation on signage_stock_notices;
create policy tenant_isolation on signage_stock_notices
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on signage_stock_notices to m2office_app;
