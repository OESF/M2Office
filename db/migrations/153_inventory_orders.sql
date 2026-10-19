-- 発注の記録と発注書（仕様書 第29.14.4節・第29.14.5節。第 0.412.0 版。Q-249）
--
-- inventory_orders: 仕入先ごとの発注 1 件。状態は pending（メールは承認待ち・Web と電話は発注前）・ordered（入荷待ち）・
--                   partial（一部入荷）・received（入荷済み）・cancelled（取り消し）。届く予定の日は発注した日 ＋ 仕入れにかかる日数。
-- inventory_order_lines: 発注の品目と数（使う単位）・届いた数。
-- inventory_order_receipts: 入庫で消し込んだ数（入庫の記録ごと）。入庫を取り消したら消し込みも戻す。
create table if not exists inventory_orders (
  id             text primary key,
  tenant_id      text not null references tenants(id) on delete cascade,
  number         text not null,
  supplier_id    text references inventory_suppliers(id) on delete set null,
  supplier_name  text not null,
  method         text not null check (method in ('mail', 'web', 'phone')),
  status         text not null default 'pending' check (status in ('pending', 'ordered', 'partial', 'received', 'cancelled')),
  ordered_at     timestamptz,
  due_on         date,
  run_id         text,
  file_id        text,
  created_by     text not null,
  created_at     timestamptz not null default now(),
  closed_at      timestamptz,
  unique (tenant_id, number)
);
create index if not exists inventory_orders_open_idx on inventory_orders (tenant_id, status, created_at);

create table if not exists inventory_order_lines (
  id         text primary key,
  tenant_id  text not null references tenants(id) on delete cascade,
  order_id   text not null references inventory_orders(id) on delete cascade,
  item_id    text not null references inventory_items(id),
  qty        numeric(12, 3) not null check (qty > 0),
  received   numeric(12, 3) not null default 0
);
create index if not exists inventory_order_lines_item_idx on inventory_order_lines (tenant_id, item_id);

create table if not exists inventory_order_receipts (
  id         text primary key,
  tenant_id  text not null references tenants(id) on delete cascade,
  line_id    text not null references inventory_order_lines(id) on delete cascade,
  move_id    text not null,
  qty        numeric(12, 3) not null,
  created_at timestamptz not null default now()
);
create index if not exists inventory_order_receipts_move_idx on inventory_order_receipts (tenant_id, move_id);

do $$
declare t text;
begin
  foreach t in array array['inventory_orders', 'inventory_order_lines', 'inventory_order_receipts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
  end loop;
end $$;

grant select, insert, update, delete on inventory_orders, inventory_order_lines, inventory_order_receipts to m2office_app;
