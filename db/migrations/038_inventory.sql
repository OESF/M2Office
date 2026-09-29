-- 在庫管理（内蔵の拡張。既定は切り）。仕様書 第29章・第12.13節、ADR-0045
--
-- 在庫の数は入出庫の記録の合計で決まる。記録は追記のみ（アプリのロールに更新と削除を許さない）。
-- いまの数（inventory_stock）は、記録と同じトランザクションで直す。在庫は会社で共有する（利用者で行を絞らない）。
-- 人の情報を持たない（第29.17節）。引き当ては予約の番号と日時だけを持つ。

-- 会社の設定の区分: 在庫管理を使うか・機能の入り切り・残りわずかの既定の目安など（第29.4.1節）
alter table tenant_settings add column if not exists inventory jsonb;

-- 仕入先（発注の方法と仕入れにかかる日数。第29.4.1節）
create table if not exists inventory_suppliers (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  name        text not null,
  -- mail / web / phone
  method      text not null default 'mail' check (method in ('mail', 'web', 'phone')),
  -- メールの宛先・発注の画面の URL・電話番号
  contact     text not null default '',
  lead_days   integer,
  note        text not null default '',
  status      text not null default 'active' check (status in ('active', 'stopped')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists inventory_items (
  id                  text primary key,
  tenant_id           text not null references tenants(id) on delete cascade,
  name                text not null,
  -- 公開の表に出す名前（空なら name）
  public_name         text not null default '',
  -- 自社のコード（任意）
  sku                 text not null default '',
  category            text not null default '',
  -- いちばん小さい使う単位（例: 個・回）と、仕入れの単位（例: 箱）と入り数
  unit                text not null default '個',
  pack_unit           text not null default '',
  pack_size           numeric(12, 3),
  -- 公開の表に出す販売価格（在庫の評価ではない。第29.18節）
  price               numeric(12, 2),
  price_tax_included  boolean not null default true,
  photo_file_id       text,
  -- 残りわずかの目安（null なら会社の既定）
  low_threshold       numeric(12, 3),
  supplier_id         text references inventory_suppliers(id) on delete set null,
  lead_days           integer,
  note                text not null default '',
  status              text not null default 'active' check (status in ('active', 'stopped')),
  created_by          text not null,
  created_at          timestamptz not null default now(),
  updated_by          text not null,
  updated_at          timestamptz not null default now()
);
create index if not exists inventory_items_tenant_idx on inventory_items (tenant_id, status, name);

-- バーコード（1 つの品目にいくつでも。会社の中で重ならない）
create table if not exists inventory_codes (
  tenant_id   text not null references tenants(id) on delete cascade,
  item_id     text not null references inventory_items(id) on delete cascade,
  value       text not null,
  kind        text not null default 'other',
  created_at  timestamptz not null default now(),
  primary key (tenant_id, value)
);
create index if not exists inventory_codes_item_idx on inventory_codes (tenant_id, item_id);

-- 場所（倉庫とその中の棚の 2 段。棚が空なら倉庫そのもの）
create table if not exists inventory_locations (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  warehouse   text not null,
  shelf       text not null default '',
  -- 棚のラベルの QR に入れる値（推測されにくい値）
  label_key   text not null unique,
  status      text not null default 'active' check (status in ('active', 'removed')),
  created_at  timestamptz not null default now()
);
create unique index if not exists inventory_locations_name_idx on inventory_locations (tenant_id, warehouse, shelf) where status = 'active';

-- ロット（使用期限を持つ）
create table if not exists inventory_lots (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  item_id     text not null references inventory_items(id) on delete cascade,
  lot         text not null,
  expires_on  date,
  created_at  timestamptz not null default now(),
  unique (tenant_id, item_id, lot)
);

-- 入出庫の記録（追記のみ）。数は使う単位で、いつも正の値。種類で増減を決める
create table if not exists inventory_moves (
  id                text primary key,
  tenant_id         text not null references tenants(id) on delete cascade,
  -- in（入庫）/ out（使用）/ transfer（移動）/ adjust（調整。qty に符号を持たせず、delta で持つ）
  kind              text not null check (kind in ('in', 'out', 'transfer', 'adjust')),
  item_id           text not null references inventory_items(id),
  lot_id            text references inventory_lots(id),
  from_location_id  text references inventory_locations(id),
  to_location_id    text references inventory_locations(id),
  -- 増減の量（使う単位）。in と adjust の増は正、out と adjust の減は負。transfer は動かした量（正）
  delta             numeric(12, 3) not null,
  reason            text not null default '',
  -- manual / slip / count / reservation / secretary / import / undo
  source            text not null default 'manual',
  source_id         text,
  -- 取り消しの記録なら、取り消した記録の ID
  reversal_of       text references inventory_moves(id),
  created_by        text not null,
  created_at        timestamptz not null default now()
);
-- 同じ操作で一緒に足した記録の組（使用期限の近いロットから分けて減らしたときなど）。取り消しはこの組の単位で行う
alter table inventory_moves add column if not exists batch_id text;
create index if not exists inventory_moves_item_idx on inventory_moves (tenant_id, item_id, created_at desc);
create index if not exists inventory_moves_batch_idx on inventory_moves (tenant_id, batch_id);
create index if not exists inventory_moves_time_idx on inventory_moves (tenant_id, created_at desc);

-- いまの数（場所とロットごと）。入出庫の記録と同じトランザクションで直す
create table if not exists inventory_stock (
  tenant_id    text not null references tenants(id) on delete cascade,
  item_id      text not null references inventory_items(id) on delete cascade,
  location_id  text not null references inventory_locations(id),
  -- ロットを使わない品目は空文字（一意の索引に null を入れないため）
  lot_key      text not null default '',
  lot_id       text references inventory_lots(id),
  qty          numeric(12, 3) not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, item_id, location_id, lot_key)
);

-- 引き当て（予約で取り置いた数。予約した人の情報を持たない。第29.13節）
create table if not exists inventory_reservations (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  item_id      text not null references inventory_items(id),
  qty          numeric(12, 3) not null check (qty > 0),
  -- 予約の番号と日時（予約のサービスの番号か、画面・秘書で入れたもの）
  booking_ref  text not null default '',
  booked_at    timestamptz,
  -- held（取り置き）/ used（使った）/ cancelled（取り消し）
  status       text not null default 'held' check (status in ('held', 'used', 'cancelled')),
  -- screen / secretary / service
  source       text not null default 'screen',
  created_by   text not null,
  created_at   timestamptz not null default now(),
  closed_at    timestamptz
);
create index if not exists inventory_reservations_item_idx on inventory_reservations (tenant_id, item_id) where status = 'held';

-- 棚卸しと、その行
create table if not exists inventory_counts (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  -- all / location / category
  scope         text not null default 'all',
  scope_value   text not null default '',
  -- open（数えている）/ closed（確定）/ cancelled
  status        text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  started_by    text not null,
  started_at    timestamptz not null default now(),
  closed_by     text,
  closed_at     timestamptz
);
create table if not exists inventory_count_lines (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  count_id      text not null references inventory_counts(id) on delete cascade,
  item_id       text not null references inventory_items(id),
  location_id   text not null references inventory_locations(id),
  lot_key       text not null default '',
  lot_id        text references inventory_lots(id),
  counted       numeric(12, 3) not null default 0,
  -- 数えた時点の帳簿の数（数えている間の入出庫と比べないため）
  book_at_count numeric(12, 3) not null default 0,
  counted_by    text not null,
  updated_at    timestamptz not null default now(),
  unique (count_id, item_id, location_id, lot_key)
);

-- 公開（何を出すかを管理者が一度承認する。第29.12節）
create table if not exists inventory_publications (
  tenant_id     text primary key references tenants(id) on delete cascade,
  -- 公開の URL の鍵（推測されにくい値）
  public_key    text not null unique,
  -- 承認した中身: { itemIds, fields, showCount }
  approved      jsonb not null,
  approved_by   text not null,
  approved_at   timestamptz not null,
  -- live（公開中）/ stopped（停止）
  status        text not null default 'live' check (status in ('live', 'stopped')),
  -- 作り直した公開の中身（見る人が多くても在庫の表を直接読まない）
  snapshot      jsonb,
  snapshot_at   timestamptz
);

do $$
declare t text;
begin
  foreach t in array array['inventory_suppliers', 'inventory_items', 'inventory_codes', 'inventory_locations', 'inventory_lots',
                           'inventory_moves', 'inventory_stock', 'inventory_reservations', 'inventory_counts',
                           'inventory_count_lines', 'inventory_publications'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
  end loop;
end $$;

grant select, insert, update, delete on inventory_suppliers, inventory_items, inventory_codes, inventory_locations, inventory_lots,
  inventory_stock, inventory_reservations, inventory_counts, inventory_count_lines, inventory_publications to m2office_app;
-- 入出庫の記録は追記のみ（取り消しは逆の記録を足す。第29.9節）
grant select, insert on inventory_moves to m2office_app;

-- 公開のページとデータは、ログインの無い人が鍵で読む。会社の境界を越えて鍵から会社を引くため、鍵で 1 行だけ返す関数にする
create or replace function m2o_inventory_publication(p_key text)
returns table (tenant_id text, status text, snapshot jsonb, snapshot_at timestamptz)
language sql stable security definer set search_path = public as $$
  select tenant_id, status, snapshot, snapshot_at from inventory_publications where public_key = p_key
$$;
grant execute on function m2o_inventory_publication(text) to m2office_app;
