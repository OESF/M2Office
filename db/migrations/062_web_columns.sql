-- Web のコラム（内蔵の拡張。仕様書 第32章・第32.18.1節）
-- 1. 会社の設定の区分（分野・読み手・業種・監修者・AI の表示・WordPress の入れ先）
alter table tenant_settings add column if not exists web_columns jsonb;

-- 2. WordPress のアプリケーションパスワードは、会社の接続の秘密の値として暗号化して預ける（サイトの URL と利用者名は meta）
alter table tenant_credentials drop constraint if exists tenant_credentials_kind_check;
alter table tenant_credentials add constraint tenant_credentials_kind_check check (kind in ('gemini', 'google_oauth', 'wordpress'));

-- 3. コラム。会社で共有する。状態: writing（書いています）・draft（下書き）・awaiting（承認待ち）・approved（承認済み）・placed（WordPress に入れた）・failed（書けなかった）
create table if not exists web_columns (
  id                text primary key,
  tenant_id         text not null references tenants(id) on delete cascade,
  theme             text not null,
  memo              text not null default '',
  status            text not null default 'writing' check (status in ('writing', 'draft', 'awaiting', 'approved', 'placed', 'failed')),
  current_version   integer not null default 0,
  -- 承認へ進めた版と、その版の中身の指紋（承認の後に版が変わっていたら入れない）
  submitted_version integer,
  submitted_digest  text,
  run_id            text,
  wp_post_id        text,
  wp_edit_url       text,
  failure           text,
  created_by        text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists web_columns_tenant_updated on web_columns (tenant_id, updated_at desc);

-- 4. コラムの版。直すたびに足す（題名の候補・本文・説明文・SNS の告知文・出典・赤入れ）
create table if not exists web_column_versions (
  tenant_id    text not null references tenants(id) on delete cascade,
  column_id    text not null references web_columns(id) on delete cascade,
  version      integer not null,
  title        text not null,
  titles       jsonb not null default '[]',
  body         text not null,
  description  text not null default '',
  sns          jsonb not null default '{}',
  sources      jsonb not null default '[]',
  review       jsonb not null default '[]',
  -- writer（AI が書いた）・rewrite（書き直しを頼んだ）・edit（人が直した）・suggestion（直し案に置き換えた）・restore（前の版に戻した）
  origin       text not null,
  created_by   text not null,
  created_at   timestamptz not null default now(),
  primary key (tenant_id, column_id, version)
);

do $$
declare t text;
begin
  foreach t in array array['web_columns', 'web_column_versions'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
  end loop;
end $$;
grant select, insert, update, delete on web_columns, web_column_versions to m2office_app;
