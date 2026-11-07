-- 資料（仕様書 第44章）の段 3（社内の共有・会社の知識・古い版の知らせ）と段 4（OKF での書き出し）。
-- 共有の範囲（library_items.share_scope）は段 1 で作ってある。ここでは共有の相手と、M2Office が足したドライブの権限を持つ（元に戻すため）。
--
-- 巻き戻し: 前の版に戻しても動く（足した表と列は読まれない。共有の範囲が self でない資料は、前の版では本人にだけ見える）。消すなら
--   drop table library_shares; drop table library_owner_state; drop table library_okf_files;
--   alter table library_items drop column knowledge_id, drop column verified_at;

-- 共有の相手（第44.8節）。グループの共有はグループごとに 1 行、会社で共有は 1 行
create table if not exists library_shares (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  item_id     text not null references library_items(id) on delete cascade,
  scope       text not null check (scope in ('group', 'company')),
  group_id    text,
  -- M2Office が足したドライブの権限（「自分だけ」に戻すときに外す）
  emails      text[] not null default '{}',
  domain      text,
  created_by  text not null,
  created_at  timestamptz not null default now()
);
create index if not exists library_shares_item on library_shares (tenant_id, item_id);
create index if not exists library_shares_group on library_shares (tenant_id, group_id) where group_id is not null;

-- 会社の知識にした記録（第44.8節。OKF の verified に使う）
alter table library_items add column if not exists knowledge_id text;
alter table library_items add column if not exists verified_at timestamptz;
create index if not exists library_items_shared on library_items (tenant_id) where share_scope <> 'self';

-- 持ち主ごとの OKF の書き出しと、古い版を知らせた日時（第44.16節・第44.8節）
create table if not exists library_owner_state (
  tenant_id           text not null references tenants(id) on delete cascade,
  owner_id            text not null,
  okf_enabled         boolean not null default false,
  okf_written_at      timestamptz,
  okf_error           text not null default '',
  versions_notified   text[] not null default '{}',
  versions_noticed_at timestamptz,
  updated_at          timestamptz not null default now(),
  primary key (tenant_id, owner_id)
);

-- OKF で書き出したファイル。中身の控え（ハッシュ）が同じなら書き直さない
create table if not exists library_okf_files (
  tenant_id  text not null references tenants(id) on delete cascade,
  owner_id   text not null,
  -- 資料の ID。最上位の一覧は 'index'
  key        text not null,
  drive_id   text not null,
  digest     text not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, owner_id, key)
);

do $$
declare t text;
begin
  foreach t in array array['library_shares', 'library_owner_state', 'library_okf_files'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
    execute format('grant select, insert, update, delete on %I to m2office_app', t);
  end loop;
end $$;
