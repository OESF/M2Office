-- お知らせの作成（内蔵の拡張。仕様書 第35章・第35.17節）
-- 1. 会社の設定の区分（入り切り・Web を公開まで行うか・カテゴリー・流す画面）
alter table tenant_settings add column if not exists announcements jsonb;

-- 2. お知らせ。状態: draft・awaiting（承認待ち）・scheduled（予約）・published（出した）・ended（期間が終わった）・cancelled
create table if not exists announcements (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  title         text not null default '',
  body          text not null default '',
  start_date    date,
  end_date      date,
  publish_at    timestamptz,
  status        text not null default 'draft' check (status in ('draft', 'awaiting', 'scheduled', 'published', 'ended', 'cancelled')),
  channels      text[] not null default '{}',
  -- 出し先ごとの文（web・line・signage）
  texts         jsonb not null default '{}',
  -- 承認した中身の指紋（承認の後に変わっていたら出さない）
  approved_digest text,
  run_id        text,
  created_by    text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  published_at  timestamptz,
  ended_at      timestamptz
);
create index if not exists announcements_tenant on announcements (tenant_id, created_at desc);
create index if not exists announcements_due on announcements (status, publish_at);

-- 3. 出し先ごとの結果
create table if not exists announcement_outputs (
  tenant_id        text not null references tenants(id) on delete cascade,
  announcement_id  text not null references announcements(id) on delete cascade,
  channel          text not null check (channel in ('web', 'line', 'signage')),
  status           text not null default 'waiting' check (status in ('waiting', 'done', 'failed', 'ended')),
  result           jsonb not null default '{}',
  reason           text not null default '',
  done_at          timestamptz,
  primary key (announcement_id, channel)
);

do $$
declare t text;
begin
  foreach t in array array['announcements', 'announcement_outputs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
  end loop;
end $$;
grant select, insert, update, delete on announcements, announcement_outputs to m2office_app;
