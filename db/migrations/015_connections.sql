-- 接続の設定（仕様書 第14.3.3節、ADR-0007）
-- 1. 会社ごとの接続の設定。秘密の値（Gemini の鍵、OAuth のクライアント シークレット）は暗号化して secret_enc に入れる。
--    秘密でない値（契約の形態、モデル名、クライアント ID）は meta に入れる
create table if not exists tenant_credentials (
  tenant_id   text not null references tenants(id) on delete cascade,
  kind        text not null check (kind in ('gemini', 'google_oauth')),
  secret_enc  text,
  meta        jsonb not null default '{}'::jsonb,
  updated_by  text not null,
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, kind)
);

-- 2. 利用者ごとの Google の接続。リフレッシュ トークンは暗号化して入れる。トークンは画面にも API にも出さない
create table if not exists user_google_connections (
  tenant_id          text not null references tenants(id) on delete cascade,
  user_id            text not null references users(id) on delete cascade,
  refresh_token_enc  text not null,
  google_email       text,
  scopes             text[] not null default '{}',
  connected_at       timestamptz not null default now(),
  checked_at         timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

alter table tenant_credentials enable row level security;
drop policy if exists tenant_isolation on tenant_credentials;
create policy tenant_isolation on tenant_credentials
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on tenant_credentials to m2office_app;

alter table user_google_connections enable row level security;
drop policy if exists tenant_isolation on user_google_connections;
create policy tenant_isolation on user_google_connections
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on user_google_connections to m2office_app;
