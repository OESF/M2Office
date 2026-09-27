-- 認証の要る会社の接続（仕様書 第12.11.6節、ADR-0044）
--
-- 1. 会社の接続の認証情報。oauth はクライアント ID とシークレット（暗号化）、api_key は会社の鍵（暗号化）と見出しの名前。
--    秘密の値は画面にも API にも出さない。認可の口と求める権限は tenant_connections.auth（秘密でない）に置く
create table if not exists connection_secrets (
  tenant_id          text not null,
  connection_id      text not null,
  client_id          text,
  client_secret_enc  text,
  api_key_enc        text,
  updated_by         text not null,
  updated_at         timestamptz not null default now(),
  primary key (tenant_id, connection_id),
  foreign key (tenant_id, connection_id) references tenant_connections (tenant_id, id) on delete cascade
);

-- 2. 利用者ごとの接続の認可（oauth）。認可と更新用の認可は暗号化して入れる。
--    client_id は認可を受けたときのクライアント ID（会社がクライアント ID を替えたら、この認可は使えない）
create table if not exists user_connections (
  tenant_id          text not null,
  user_id            text not null references users(id) on delete cascade,
  connection_id      text not null,
  access_token_enc   text not null,
  refresh_token_enc  text,
  expires_at         timestamptz,
  scopes             text[] not null default '{}',
  account_label      text not null default '',
  client_id          text not null,
  connected_at       timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (tenant_id, user_id, connection_id),
  foreign key (tenant_id, connection_id) references tenant_connections (tenant_id, id) on delete cascade
);

alter table connection_secrets enable row level security;
drop policy if exists tenant_isolation on connection_secrets;
create policy tenant_isolation on connection_secrets
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on connection_secrets to m2office_app;

alter table user_connections enable row level security;
drop policy if exists tenant_isolation on user_connections;
create policy tenant_isolation on user_connections
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on user_connections to m2office_app;
