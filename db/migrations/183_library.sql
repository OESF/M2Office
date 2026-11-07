-- 資料（内蔵の拡張。仕様書 第44章）の段 1。本体は本人の Google ドライブに置き、ここには探すための目録だけを持つ（Q-309）。
-- 全文とメールの本文は持たない（Q-310）。目録は持ち主だけが読む（第44.10節。絞りは処理の SQL で行い、画面の作りに頼らない）。

alter table tenant_settings add column if not exists library jsonb;

create table if not exists library_items (
  id             text primary key,
  tenant_id      text not null references tenants(id) on delete cascade,
  owner_id       text not null,
  -- ドライブのファイル。M2Office の中で作ったファイルは、ワーカーが置くまで空（file_id が指す）
  drive_file_id  text,
  drive_url      text,
  -- M2Office がドライブに置いたファイルか。false（ドライブで選んだファイル・Google の文書）は、削除でごみ箱へ移さず目録からだけ外す（第44.5節）
  placed         boolean not null default false,
  file_id        text,
  original_name  text not null,
  format         text not null default 'other',
  mime           text not null default '',
  size_bytes     bigint not null default 0,
  sha256         text,
  entry          text not null check (entry in ('pc', 'run', 'picker', 'chat', 'mail')),
  title          text not null default '',
  doc_type       text not null default '',
  counterparty   text not null default '',
  contact_id     text,
  doc_date       date,
  received_at    timestamptz not null default now(),
  summary        text not null default '',
  keywords       text[] not null default '{}',
  search_text    text not null default '',
  read_state     text not null default 'pending' check (read_state in ('pending', 'done', 'unreadable', 'too_large', 'paused')),
  read_note      text not null default '',
  read_scope     text not null default '',
  -- 人が直した項目（AI が読み直しても書き換えない）
  edited         text[] not null default '{}',
  attempts       integer not null default 0,
  next_try_at    timestamptz not null default now(),
  share_scope    text not null default 'self' check (share_scope in ('self', 'group', 'company')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists library_items_owner on library_items (tenant_id, owner_id, received_at desc);
create index if not exists library_items_work on library_items (tenant_id, next_try_at) where read_state = 'pending';
-- 同じ中身・同じドライブのファイルは、1 人に 1 つにまとめる（第44.4節）
create unique index if not exists library_items_hash on library_items (tenant_id, owner_id, sha256) where sha256 is not null;
create unique index if not exists library_items_drive on library_items (tenant_id, owner_id, drive_file_id) where drive_file_id is not null;

create table if not exists library_item_origins (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  item_id      text not null references library_items(id) on delete cascade,
  entry        text not null check (entry in ('pc', 'run', 'picker', 'chat', 'mail')),
  -- 元のフォルダの名前（PC から入れたとき）
  folder       text not null default '',
  artifact_id  text,
  run_id       text,
  -- メールから来たとき（段 2）
  message_id   text,
  sender       text not null default '',
  subject      text not null default '',
  created_at   timestamptz not null default now()
);
create index if not exists library_item_origins_item on library_item_origins (item_id);
create unique index if not exists library_item_origins_artifact on library_item_origins (tenant_id, artifact_id) where artifact_id is not null;

-- 削除した資料のハッシュ。メールなどの自動の入口から、同じファイルを取り込み直さないため（中身は持たない）
create table if not exists library_tombstones (
  tenant_id   text not null references tenants(id) on delete cascade,
  owner_id    text not null,
  sha256      text not null,
  deleted_at  timestamptz not null default now(),
  primary key (tenant_id, owner_id, sha256)
);

-- 持ち主のドライブの「M2Office 資料」とその下の年のフォルダの ID
create table if not exists library_folders (
  tenant_id  text not null references tenants(id) on delete cascade,
  owner_id   text not null,
  key        text not null,
  drive_id   text not null,
  primary key (tenant_id, owner_id, key)
);

do $$
declare t text;
begin
  foreach t in array array['library_items', 'library_item_origins', 'library_tombstones', 'library_folders'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
    execute format('grant select, insert, update, delete on %I to m2office_app', t);
  end loop;
end $$;
