-- 外部のアプリ（仕様書 第13.4.1節、ADR-0090。第 0.326.0 版）と、その在庫の機能（販売管理とのつなぎ。第29.20.1節、ADR-0087）
--
-- 会社の管理者がアプリを登録し、鍵と機能を選んで承認する。外のシステムは鍵で、画面と同じ /v1 の道を呼ぶ。
-- 鍵はハッシュだけを持つ（作ったときと出し直したときに一度だけ見せる）。金額・支払い・お客様の情報は持たない。
-- 通知の本文は持たず、二重に数えないための番号と中身のハッシュと返した答えだけを持つ。

-- アプリ（1 社に 20 まで）
create table if not exists ext_apps (
  id               text primary key,
  tenant_id        text not null references tenants(id) on delete cascade,
  name             text not null,
  key_hash         text not null unique,
  status           text not null default 'active' check (status in ('active', 'stopped')),
  -- 承認した機能。承認するまでは空で、どの機能も使えない
  functions        text[] not null default '{}',
  -- 承認した機能ごとの設定（catalog: 渡す品目と項目）
  settings         jsonb not null default '{}',
  -- 承認し直して「商品の一覧」の範囲から外した品目と時刻（updatedSince の答えに active: false で 1 度入れるため）
  catalog_removed  jsonb not null default '[]',
  approved_by      text,
  approved_at      timestamptz,
  created_by       text not null,
  created_at       timestamptz not null default now(),
  last_used_at     timestamptz
);

-- 呼び出しの数（日ごと。画面の「この 7 日の呼び出し」）
create table if not exists ext_app_usage (
  tenant_id  text not null references tenants(id) on delete cascade,
  app_id     text not null references ext_apps(id) on delete cascade,
  day        date not null,
  calls      integer not null default 0,
  primary key (tenant_id, app_id, day)
);

-- 書き込みの機能に届いた通知（二重に数えないため）。本文は持たず、中身のハッシュと返した答えだけ
create table if not exists ext_app_events (
  tenant_id   text not null references tenants(id) on delete cascade,
  app_id      text not null references ext_apps(id) on delete cascade,
  kind        text not null,
  event_ref   text not null,
  body_hash   text not null,
  -- 返した答え。null は処理の途中
  response    jsonb,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, app_id, kind, event_ref)
);

-- 販売（アプリ＋販売番号で 1 件）。取り置きと使用の記録の組を持ち、取り消しで戻す
create table if not exists inventory_sales (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  app_id       text not null references ext_apps(id) on delete cascade,
  sale_ref     text not null,
  -- ordered（注文）/ sold（販売）/ cancelled（取り消し）。この順にだけ進む
  status       text not null check (status in ('ordered', 'sold', 'cancelled')),
  -- 取り置き（inventory_reservations の ID）と、使用の記録の組ごとに中の記録 1 つの ID
  hold_ids     jsonb not null default '[]',
  sold_moves   jsonb not null default '[]',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, app_id, sale_ref)
);

-- 照らせなかった行（品目を選べば、その時点で記録する）
create table if not exists inventory_sale_unmatched (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  app_id       text not null references ext_apps(id) on delete cascade,
  sale_id      text not null references inventory_sales(id) on delete cascade,
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

do $$
declare t text;
begin
  foreach t in array array['ext_apps', 'ext_app_usage', 'ext_app_events', 'inventory_sales', 'inventory_sale_unmatched'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
  end loop;
end $$;

grant select, insert, update, delete on ext_apps, ext_app_usage, ext_app_events, inventory_sales, inventory_sale_unmatched to m2office_app;

-- アプリは、ログインの無いまま鍵で呼ぶ。鍵のハッシュから会社とアプリを 1 行だけ返す
create or replace function m2o_ext_app(p_hash text)
returns table (id text, tenant_id text, status text, functions text[], name text)
language sql stable security definer set search_path = public as $$
  select id, tenant_id, status, functions, name from ext_apps where key_hash = p_hash
$$;
grant execute on function m2o_ext_app(text) to m2office_app;
