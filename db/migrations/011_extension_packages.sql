-- 持ち運べる拡張機能（仕様書 第12.10節）
-- 1. 導入した拡張機能の有効・無効（スイッチ）。切り替えに同意のやり直しは要らない（第12.10.4節）
alter table tenant_extensions add column if not exists enabled boolean not null default true;

-- 2. ファイル（.m2ext）から取り込んだ拡張機能（自社専用）。取り込んだ会社にだけ見える（第12.10.3節）
--    中身はパス→Base64 の対応として保存する。プログラムは検証で拒否済みであり、ここには入らない
create table if not exists tenant_extension_packages (
  tenant_id     text not null references tenants(id) on delete cascade,
  extension_id  text not null,
  version       text not null,
  files         jsonb not null,
  size_bytes    integer not null,
  imported_by   text not null,
  imported_at   timestamptz not null default now(),
  primary key (tenant_id, extension_id)
);

alter table tenant_extension_packages enable row level security;
drop policy if exists tenant_isolation on tenant_extension_packages;
create policy tenant_isolation on tenant_extension_packages
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on tenant_extension_packages to m2office_app;
