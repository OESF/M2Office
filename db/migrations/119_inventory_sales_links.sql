-- 在庫管理と販売管理のつなぎ（仕様書 第29.20.1節、ADR-0087。第 0.325.0 版で実装）
--
-- 販売管理（レジ・POS・EC）が鍵で、承認した範囲の商品の一覧を読み、販売を知らせる。
-- 金額・支払い・お客様の情報は持たない（第29.17節・第29.18節）。通知の本文は持たず、二重に数えないための番号と中身のハッシュだけを持つ。

-- つなぎ（会社ごとに 8 つまで）。鍵はハッシュだけを持つ（作ったときと出し直したときに一度だけ見せる）
create table if not exists inventory_sales_links (
  id             text primary key,
  tenant_id      text not null references tenants(id) on delete cascade,
  name           text not null,
  key_hash       text not null unique,
  status         text not null default 'active' check (status in ('active', 'stopped')),
  -- 渡す範囲（品目・数か状態か・販売価格・社員価格）。承認するまでは null で、一覧に何も渡さない
  scope          jsonb,
  approved_by    text,
  approved_at    timestamptz,
  -- 承認し直して範囲から外した品目と時刻（updatedSince の答えに active: false で 1 度入れるため）
  removed        jsonb not null default '[]',
  created_by     text not null,
  created_at     timestamptz not null default now(),
  last_read_at   timestamptz,
  last_event_at  timestamptz
);

-- 販売（つなぎ＋販売番号で 1 件）。取り置きと使用の記録の組を持ち、取り消しで戻す
create table if not exists inventory_sales (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  link_id      text not null references inventory_sales_links(id) on delete cascade,
  sale_ref     text not null,
  -- ordered（注文）/ sold（販売）/ cancelled（取り消し）。この順にだけ進む
  status       text not null check (status in ('ordered', 'sold', 'cancelled')),
  -- 取り置き（inventory_reservations の ID）と、使用の記録の組（inventory_moves の batch_id）
  hold_ids     jsonb not null default '[]',
  sold_batches jsonb not null default '[]',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, link_id, sale_ref)
);

-- 照らせなかった行（品目を選べば、その時点で記録する）
create table if not exists inventory_sale_unmatched (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  link_id      text not null references inventory_sales_links(id) on delete cascade,
  sale_id      text not null references inventory_sales(id) on delete cascade,
  -- 行で行うはずだったこと（取り置き・使用・入庫）
  action       text not null check (action in ('hold', 'use', 'return')),
  item_ref     text not null default '',
  code         text not null default '',
  barcode      text not null default '',
  qty          numeric(12, 3) not null check (qty > 0),
  reason       text not null default '',
  -- open（選ぶのを待つ）/ resolved（選んで記録した）/ dropped（取り消しなどで要らなくなった）
  status       text not null default 'open' check (status in ('open', 'resolved', 'dropped')),
  resolved_by  text,
  resolved_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists inventory_sale_unmatched_open_idx on inventory_sale_unmatched (tenant_id, status, created_at desc);

-- 届いた通知（二重に数えないため）。本文は持たず、中身のハッシュと返した答えだけ
create table if not exists inventory_sale_events (
  tenant_id    text not null references tenants(id) on delete cascade,
  link_id      text not null references inventory_sales_links(id) on delete cascade,
  event_ref    text not null,
  body_hash    text not null,
  -- 返した答え。null は処理の途中
  response     jsonb,
  created_at   timestamptz not null default now(),
  primary key (tenant_id, link_id, event_ref)
);
create index if not exists inventory_sale_events_time_idx on inventory_sale_events (tenant_id, link_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['inventory_sales_links', 'inventory_sales', 'inventory_sale_unmatched', 'inventory_sale_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
  end loop;
end $$;

grant select, insert, update, delete on inventory_sales_links, inventory_sales, inventory_sale_unmatched, inventory_sale_events to m2office_app;

-- 販売管理は、ログインの無いまま鍵で呼ぶ。鍵のハッシュから会社とつなぎを 1 行だけ返す
create or replace function m2o_inventory_sales_link(p_hash text)
returns table (id text, tenant_id text, status text)
language sql stable security definer set search_path = public as $$
  select id, tenant_id, status from inventory_sales_links where key_hash = p_hash
$$;
grant execute on function m2o_inventory_sales_link(text) to m2office_app;
