-- 販促物の作成の Canva とのつなぎ（仕様書 第41.19.3節。第 0.293.0 版）。
-- 本人ごとの Canva の接続（リフレッシュ トークンは暗号化して持つ。1 回使うと替わる）と、販促物ごとの取り込んだデザイン。

create table if not exists canva_connections (
  tenant_id          text not null references tenants(id) on delete cascade,
  user_id            text not null,
  refresh_token_enc  text not null,
  connected_at       timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

alter table canva_connections enable row level security;
drop policy if exists tenant_isolation on canva_connections;
create policy tenant_isolation on canva_connections
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on canva_connections to m2office_app;

alter table print_designs add column if not exists canva jsonb;
