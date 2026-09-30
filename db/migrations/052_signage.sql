-- 店頭サイネージの段 1（画面の登録・素材・流れ）。仕様書 第31章・第31.15.1節、ADR-0051
--
-- 料金は取らない標準の機能で、会社ごとに入り切りする（既定は切り。第31.2節）。
-- 画面は 1 社 3 台まで（全社共通の決まり。第31.4節）。画面の鍵は SHA-256 のハッシュだけを持つ。
-- 素材の中身は会社ごとのファイルの置き場に置き、会社のファイル（files）の表には入れない（第31.6.1節）。

alter table tenant_settings add column if not exists signage jsonb;

-- 画面（端末 1 台に 1 画面）
create table if not exists signage_screens (
  id                  text primary key,
  tenant_id           text not null references tenants(id) on delete cascade,
  name                text not null check (char_length(name) between 1 and 20),
  orientation         text not null check (orientation in ('landscape', 'portrait')),
  rotation            integer not null default 0 check (rotation in (0, 90, 180, 270)),
  volume              integer not null default 70 check (volume between 0 and 100),
  key_hash            text unique,
  status              text not null default 'active' check (status in ('active', 'removed')),
  flow_version        integer not null default 0,
  last_seen_at        timestamptz,
  last_report         jsonb,
  offline_notified_at timestamptz,
  registered_by       text not null,
  registered_at       timestamptz not null default now(),
  updated_by          text,
  updated_at          timestamptz not null default now(),
  removed_at          timestamptz
);
-- 名前は会社の中で、使っている画面どうしで重ならない
create unique index if not exists signage_screens_name on signage_screens (tenant_id, name) where status = 'active';

-- ふだん動いている時間帯（30 分ごとの 48 の時間帯を 48 ビットで。日本時間の日。14 日で消す）
create table if not exists signage_screen_presence (
  tenant_id  text not null references tenants(id) on delete cascade,
  screen_id  text not null references signage_screens(id) on delete cascade,
  day        date not null,
  slots      bigint not null default 0,
  primary key (screen_id, day)
);

-- 登録を待つ番号（10 分で切れる。鍵を渡したら消す）
create table if not exists signage_pairings (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  code         text not null check (code ~ '^[0-9]{6}$'),
  secret_hash  text not null,
  viewport     jsonb not null,
  expires_at   timestamptz not null,
  screen_id    text references signage_screens(id) on delete cascade,
  created_at   timestamptz not null default now()
);
create index if not exists signage_pairings_code on signage_pairings (tenant_id, code);

-- 素材（画像・動画）
create table if not exists signage_assets (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  kind         text not null check (kind in ('image', 'video', 'html')),
  name         text not null check (char_length(name) between 1 and 60),
  mime         text not null check (mime in ('image/jpeg', 'image/png', 'video/mp4', 'text/html')),
  bytes        bigint not null check (bytes > 0),
  sha256       text not null,
  width        integer not null check (width > 0),
  height       integer not null check (height > 0),
  duration_ms  integer,
  thumbnail    bytea check (thumbnail is null or octet_length(thumbnail) <= 102400),
  is_interrupt boolean not null default false,
  jingle       text,
  created_by   text not null,
  created_at   timestamptz not null default now(),
  updated_by   text,
  updated_at   timestamptz not null default now(),
  unique (tenant_id, sha256)
);

-- 流れの 1 行（画面ごとの素材の並び。並びごと置き換える）
create table if not exists signage_entries (
  id         text primary key,
  tenant_id  text not null references tenants(id) on delete cascade,
  screen_id  text not null references signage_screens(id) on delete cascade,
  asset_id   text not null references signage_assets(id) on delete cascade,
  position   integer not null check (position >= 0),
  seconds    integer check (seconds is null or seconds between 3 and 120),
  unique (screen_id, position) deferrable initially deferred
);

do $$
declare t text;
begin
  foreach t in array array['signage_screens', 'signage_screen_presence', 'signage_pairings', 'signage_assets', 'signage_entries'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
  end loop;
end $$;

grant select, insert, update, delete on signage_screens, signage_screen_presence, signage_pairings, signage_assets, signage_entries to m2office_app;
