-- コラムのナレーション付きスライド（仕様書 第32.18.6節 段 3。第 0.353.0 版。ADR-0094）
--
-- 組の種類に narrated（スライド＋読み上げ＋BGM の MP4）を足し、声と BGM を組に持つ。読み上げ文は場面（scenes）に持つ。
-- 会社の曲（BGM）は、会社が使う権利を持つ MP3・WAV（1 曲 5 MB・5 分まで、10 曲まで）。
-- サイネージの素材に、ナレーション付きか（スケジュールに足すとはじめから音あり。Q-233）を持つ。
alter table column_signage drop constraint if exists column_signage_kind_check;
alter table column_signage add constraint column_signage_kind_check check (kind in ('slides', 'video', 'narrated'));
alter table column_signage add column if not exists voice text;
alter table column_signage add column if not exists bgm text;

create table if not exists column_bgm (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 40),
  mime         text not null check (mime in ('audio/mpeg', 'audio/wav')),
  bytes        bytea not null check (octet_length(bytes) between 1 and 5242880),
  sha256       text not null,
  duration_ms  integer not null check (duration_ms between 1 and 300000),
  created_by   text not null,
  created_at   timestamptz not null default now(),
  unique (tenant_id, name)
);
alter table column_bgm enable row level security;
drop policy if exists tenant_isolation on column_bgm;
create policy tenant_isolation on column_bgm using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on column_bgm to m2office_app;

alter table signage_assets add column if not exists narration boolean not null default false;
