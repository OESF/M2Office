-- 会社の接続（コネクタ。MCP サーバ）。仕様書 第12.11節、ADR-0037
--
-- コネクタは拡張機能の一部ではなく、道具を供給する会社の資源として管理する。
-- 管理者が URL から登録するか、拡張機能に同梱されたものを導入のときに登録する。
-- 道具の一覧と危険度（tools）は、管理者が決めたものを保存する。
create table if not exists tenant_connections (
  tenant_id    text not null references tenants(id) on delete cascade,
  id           text not null,
  name         text not null,
  description  text not null default '',
  transport    text not null default 'http',
  url          text not null,
  auth         jsonb not null default '{"type":"none"}',
  tools        jsonb not null default '[]',
  -- 登録の由来。manual（管理者が登録）か extension:<拡張機能の ID>（同梱）
  origin       text not null default 'manual',
  created_by   text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, id)
);

alter table tenant_connections enable row level security;
drop policy if exists tenant_isolation on tenant_connections;
create policy tenant_isolation on tenant_connections
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on tenant_connections to m2office_app;
