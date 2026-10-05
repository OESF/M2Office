-- 店頭サイネージの時間帯の流れ（仕様書 第31.6.6節。第 0.264.0 版）
-- 1. 時間帯（画面ごとに 3 つまで。時刻は日本時間の 0 時からの分。曜日は 7 ビット（月=1、火=2、…、日=64））
create table if not exists signage_bands (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  screen_id   text not null references signage_screens(id) on delete cascade,
  start_min   integer not null check (start_min between 0 and 1439),
  end_min     integer not null check (end_min between 0 and 1439),
  days        integer not null default 127 check (days between 1 and 127),
  position    integer not null default 0,
  created_by  text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists signage_bands_screen on signage_bands (tenant_id, screen_id, position);

alter table signage_bands enable row level security;
drop policy if exists tenant_isolation on signage_bands;
create policy tenant_isolation on signage_bands
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on signage_bands to m2office_app;

-- 2. 流れの 1 行がどの時間帯のものか（無ければいつもの流れ）。並びの重なりは、流れ（時間帯）ごとに見る
alter table signage_entries add column if not exists band_id text references signage_bands(id) on delete cascade;
alter table signage_entries drop constraint if exists signage_entries_screen_id_position_key;
create unique index if not exists signage_entries_band_position on signage_entries (screen_id, coalesce(band_id, ''), position);
