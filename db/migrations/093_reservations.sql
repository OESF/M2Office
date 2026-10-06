-- 会議室・社用車・備品の予約（内蔵の拡張。仕様書 第37章）。
-- 予約できるものと予約を会社ごとに持つ。同じものの、時間が重なる予約は、データベースの制約で断る（第37.12節）。
-- 画面と秘書が同時に取っても重ならない。

-- 期間の重なりを断る制約で、ものの ID の「等しい」を使うため
create extension if not exists btree_gist;

alter table tenant_settings add column if not exists reservations jsonb;

create table if not exists reservable_items (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 40),
  kind        text not null default 'other' check (kind in ('room', 'car', 'equipment', 'other')),
  capacity    integer check (capacity is null or capacity between 1 and 1000),
  location    text not null default '',
  sort_order  integer not null default 0,
  status      text not null default 'active' check (status in ('active', 'stopped')),
  created_by  text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, name)
);

create table if not exists reservations (
  id                 text primary key,
  tenant_id          text not null references tenants(id) on delete cascade,
  item_id            text not null references reservable_items(id) on delete cascade,
  start_at           timestamptz not null,
  end_at             timestamptz not null,
  purpose            text not null default '',
  user_id            text not null,
  calendar_event_id  text,
  status             text not null default 'booked' check (status in ('booked', 'cancelled')),
  created_by         text not null,
  created_at         timestamptz not null default now(),
  updated_by         text not null,
  updated_at         timestamptz not null default now(),
  check (end_at > start_at),
  -- 同じものの予約の時間が重ならない（終わりと始めが同じ時刻なら重ならない）。取り消した予約は数えない
  constraint reservations_no_overlap exclude using gist (
    tenant_id with =, item_id with =, tstzrange(start_at, end_at, '[)') with &&
  ) where (status = 'booked')
);
create index if not exists reservations_tenant_time on reservations (tenant_id, start_at, end_at) where status = 'booked';
create index if not exists reservations_user on reservations (tenant_id, user_id, start_at) where status = 'booked';

alter table reservable_items enable row level security;
drop policy if exists tenant_isolation on reservable_items;
create policy tenant_isolation on reservable_items
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on reservable_items to m2office_app;

alter table reservations enable row level security;
drop policy if exists tenant_isolation on reservations;
create policy tenant_isolation on reservations
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on reservations to m2office_app;
