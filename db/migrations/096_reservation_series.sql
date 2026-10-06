-- 繰り返しの予約（仕様書 第37.18節。予約の段 2）。
-- 繰り返しの決まり（毎週・隔週・毎月の第 n 何曜）を持ち、90 日先までの 1 回ずつの予約として作る。そこから先はワーカーが毎日足す。

create table if not exists reservation_series (
  id                  text primary key,
  tenant_id           text not null references tenants(id) on delete cascade,
  item_id             text not null references reservable_items(id) on delete cascade,
  user_id             text not null,
  purpose             text not null default '',
  rule                text not null check (rule in ('weekly', 'biweekly', 'monthly')),
  weekday             integer not null check (weekday between 0 and 6),
  -- 毎月のとき、第何週か（1〜5。5 は最後の週）
  nth                 integer check (nth is null or nth between 1 and 5),
  start_time          text not null check (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  end_time            text not null check (end_time ~ '^([01][0-9]|2[0-4]):[0-5][0-9]$'),
  starts_on           date not null,
  ends_on             date,
  status              text not null default 'active' check (status in ('active', 'stopped')),
  -- ここまで 1 回ずつの予約を作った日
  materialized_until  date,
  -- 重なって取れなかった日
  skipped             date[] not null default '{}',
  created_by          text not null,
  created_at          timestamptz not null default now()
);
create index if not exists reservation_series_tenant on reservation_series (tenant_id, status);

alter table reservations add column if not exists series_id text references reservation_series(id) on delete set null;
create index if not exists reservations_series on reservations (tenant_id, series_id) where series_id is not null;

alter table reservation_series enable row level security;
drop policy if exists tenant_isolation on reservation_series;
create policy tenant_isolation on reservation_series
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on reservation_series to m2office_app;
