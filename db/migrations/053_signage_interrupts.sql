-- 店頭サイネージの段 2（割り込み・よく出す案内・呼び出しの受け口・会社のジングルの音）。仕様書 第31.7節・第31.8節・第31.15.1節、ADR-0051
--
-- 割り込みの文と番号は、出し終えて 24 時間で消す（第31.13節）。行は 90 日で消す。
-- よく出す案内は、番号を空けた形のハッシュで数え、14 日のうちに 3 回以上使った形だけを文として持つ（第31.9.3節）。
-- 受け口の鍵は SHA-256 のハッシュだけを持ち、鍵から会社と受け口を 1 行だけ返す関数で引く（予約の受け口と同じ形）。

-- 割り込み
create table if not exists signage_interrupts (
  id              text primary key,
  tenant_id       text not null references tenants(id) on delete cascade,
  kind            text not null check (kind in ('text', 'asset')),
  text            text check (text is null or char_length(text) <= 80),
  number          text check (number is null or char_length(number) <= 8),
  asset_id        text references signage_assets(id) on delete set null,
  seconds         integer not null check (seconds between 5 and 60),
  chime           boolean not null default true,
  jingle          text,
  origin          text not null check (origin in ('staff', 'secretary', 'hook')),
  created_by      text,
  source_id       text,
  request_id      text check (request_id is null or char_length(request_id) <= 64),
  created_at      timestamptz not null default now(),
  text_purged_at  timestamptz
);
create index if not exists signage_interrupts_recent on signage_interrupts (tenant_id, created_at);
create index if not exists signage_interrupts_request on signage_interrupts (tenant_id, source_id, request_id) where request_id is not null;

-- 割り込みの画面ごとの出す先
create table if not exists signage_interrupt_targets (
  tenant_id     text not null references tenants(id) on delete cascade,
  interrupt_id  text not null references signage_interrupts(id) on delete cascade,
  screen_id     text not null references signage_screens(id) on delete cascade,
  state         text not null default 'waiting' check (state in ('waiting', 'showing', 'done', 'cleared', 'expired')),
  seconds       integer not null check (seconds between 5 and 60),
  started_at    timestamptz,
  ended_at      timestamptz,
  cleared_by    text,
  created_at    timestamptz not null default now(),
  primary key (interrupt_id, screen_id)
);
create index if not exists signage_interrupt_targets_screen on signage_interrupt_targets (tenant_id, screen_id, state);

-- よく出す案内（番号を空けた形のハッシュで数える。文は 3 回以上使った形だけ）
create table if not exists signage_phrases (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  phrase_hash   text not null,
  template      text,
  has_number    boolean not null default false,
  daily_counts  jsonb not null default '{}'::jsonb,
  last_used_at  timestamptz not null default now(),
  hidden        boolean not null default false,
  unique (tenant_id, phrase_hash)
);

-- 呼び出しの受け口
create table if not exists signage_sources (
  id                text primary key,
  tenant_id         text not null references tenants(id) on delete cascade,
  name              text not null check (char_length(name) between 1 and 40),
  hook_hash         text not null unique,
  mapping           jsonb,
  status            text not null default 'active' check (status in ('active', 'stopped')),
  last_received_at  timestamptz,
  stats             jsonb not null default '{}'::jsonb,
  created_by        text not null,
  created_at        timestamptz not null default now()
);

-- 会社のジングルの音
create table if not exists signage_sounds (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 20),
  mime         text not null check (mime in ('audio/mpeg', 'audio/wav')),
  bytes        bytea not null check (octet_length(bytes) between 1 and 307200),
  sha256       text not null,
  duration_ms  integer not null check (duration_ms between 1 and 5000),
  created_by   text not null,
  created_at   timestamptz not null default now(),
  unique (tenant_id, name)
);

do $$
declare t text;
begin
  foreach t in array array['signage_interrupts', 'signage_interrupt_targets', 'signage_phrases', 'signage_sources', 'signage_sounds'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
  end loop;
end $$;

grant select, insert, update, delete on signage_interrupts, signage_interrupt_targets, signage_phrases, signage_sources, signage_sounds to m2office_app;

-- 呼び出しの受け口は、ログインの無い相手（受付のシステム）が鍵で呼ぶ。鍵のハッシュから会社と受け口を 1 行だけ返す
create or replace function m2o_signage_source(p_hash text)
returns table (id text, tenant_id text, status text)
language sql stable security definer set search_path = public as $$
  select id, tenant_id, status from signage_sources where hook_hash = p_hash
$$;
grant execute on function m2o_signage_source(text) to m2office_app;
