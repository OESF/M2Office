-- 在庫管理の段 4（予約との引き当て）。仕様書 第29.13節
--
-- 予約そのものは外部の予約のシステムが持つ。M2Office は予約番号・日時・メニューの名前と、何をいくつ取り置いたかだけを持つ。
-- 予約した人の情報（氏名など）は持たない（第29.17節）。予約のシステムへは書き戻さない。

-- 予約の受け口（通知を受け取る URL）。URL の鍵はハッシュだけを持つ（作ったときに一度だけ見せる）
create table if not exists inventory_booking_sources (
  id                text primary key,
  tenant_id         text not null references tenants(id) on delete cascade,
  name              text not null,
  hook_hash         text not null unique,
  -- 項目の対応（型）。null なら、初めて届いた通知から AI が推測する
  mapping           jsonb,
  status            text not null default 'active' check (status in ('active', 'stopped')),
  created_by        text not null,
  created_at        timestamptz not null default now(),
  last_received_at  timestamptz
);

-- 予約（出どころ＋予約番号で 1 件）。出どころは受け口の ID か 'manual'（画面・秘書）
create table if not exists inventory_bookings (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  source_key   text not null default 'manual',
  external_id  text not null,
  starts_at    timestamptz,
  menu         text not null default '',
  -- booked（予約）/ cancelled（取り消し）/ visited（来店済み）
  status       text not null default 'booked' check (status in ('booked', 'cancelled', 'visited')),
  -- 品目に結び付いたか（メニューから品目が決まらなければ false）
  mapped       boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, source_key, external_id)
);
create index if not exists inventory_bookings_time_idx on inventory_bookings (tenant_id, starts_at);

-- メニューと品目（AI が推測して覚える。人が会話で直せる）。item_id が null の行は「在庫を使わないメニュー」
create table if not exists inventory_menu_items (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  menu_key    text not null,
  item_id     text references inventory_items(id) on delete cascade,
  qty         numeric(12, 3) not null default 1,
  learned_by  text not null default 'ai' check (learned_by in ('ai', 'user')),
  updated_at  timestamptz not null default now()
);
create unique index if not exists inventory_menu_items_key_idx on inventory_menu_items (tenant_id, menu_key, coalesce(item_id, ''));

-- 引き当てから予約を引く
alter table inventory_reservations add column if not exists booking_id text references inventory_bookings(id) on delete cascade;
create index if not exists inventory_reservations_booking_idx on inventory_reservations (tenant_id, booking_id);

do $$
declare t text;
begin
  foreach t in array array['inventory_booking_sources', 'inventory_bookings', 'inventory_menu_items'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
  end loop;
end $$;

grant select, insert, update, delete on inventory_booking_sources, inventory_bookings, inventory_menu_items to m2office_app;

-- 通知の受け口は、ログインの無い相手（予約のシステム）が鍵で呼ぶ。鍵のハッシュから会社と受け口を 1 行だけ返す
create or replace function m2o_inventory_booking_source(p_hash text)
returns table (id text, tenant_id text, status text)
language sql stable security definer set search_path = public as $$
  select id, tenant_id, status from inventory_booking_sources where hook_hash = p_hash
$$;
grant execute on function m2o_inventory_booking_source(text) to m2office_app;
