-- 定時実行・通知・ログインの状態
-- 仕様書 第9.5.5節（AG-05）、第6.5.5節（通知）、第20.7節（認証の実装方針）に対応する。

-- 定時実行（FR-311）。対象者ごとに持つ。
create table if not exists schedules (
  id             text primary key,
  tenant_id      text not null references tenants(id) on delete cascade,
  user_id        text not null references users(id) on delete cascade,
  agent_id       text not null,
  agent_version  integer not null,
  input          jsonb not null default '{}',
  -- {"kind":"weekly","weekday":1,"hour":8,"minute":0} または {"kind":"daily","hour":8,"minute":0}
  rule           jsonb not null,
  timezone       text not null default 'Asia/Tokyo',
  enabled        boolean not null default true,
  next_run_at    timestamptz not null,
  last_run_at    timestamptz,
  created_by     text not null,
  created_at     timestamptz not null default now()
);
create index if not exists schedules_due_idx on schedules (next_run_at) where enabled;
create index if not exists schedules_tenant_idx on schedules (tenant_id, user_id);

-- 本人宛の通知（notification.send の配信先）。宛先は常に 1 人。
create table if not exists notifications (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  user_id     text not null references users(id) on delete cascade,
  kind        text not null,
  title       text not null,
  body        text not null default '',
  run_id      text references runs(id) on delete set null,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists notifications_user_idx
  on notifications (tenant_id, user_id, created_at desc);

-- ログインの状態。Cookie の値そのものは保存せず、ハッシュだけを持つ。
create table if not exists sessions (
  id            text primary key,          -- Cookie の値の SHA-256
  tenant_id     text not null references tenants(id) on delete cascade,
  user_id       text not null references users(id) on delete cascade,
  csrf_token    text not null,
  provider      text not null,             -- 'google' または 'dev'
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz
);
create index if not exists sessions_user_idx on sessions (tenant_id, user_id);
