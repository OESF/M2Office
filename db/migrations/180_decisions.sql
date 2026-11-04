-- 意思決定支援（内蔵の拡張。仕様書 第43章）。
-- 相談・材料・発言（全文）・主張・論点の優勢の推移・共有を持つ。討論の推移を報告と同じくらい大事な成果として残す（第43.6.2節）。
-- 画面へ順に流すため、行を書くたびに `decision_rev` の番号を振り、画面は前に受け取った番号より大きい行だけを受け取る（第43.11.2節）。

alter table tenant_settings add column if not exists decisions jsonb;

create sequence if not exists decision_rev;
grant usage, select on sequence decision_rev to m2office_app;

create table if not exists decision_sessions (
  id              text primary key,
  tenant_id       text not null references tenants(id) on delete cascade,
  created_by      text not null,
  topic           text not null,
  question        text not null default '',
  viewpoints      jsonb not null default '[]',
  turns           integer not null default 10 check (turns between 1 and 30),
  cross_check     boolean not null default false,
  status          text not null default 'queued' check (status in ('queued', 'gathering', 'debating', 'summarizing', 'done', 'stopped', 'failed')),
  end_reason      text check (end_reason in ('turns', 'exhausted', 'stopped', 'cost', 'failed')),
  end_note        text not null default '',
  progress        text not null default '',
  missing         jsonb not null default '[]',
  digs            jsonb not null default '[]',
  comparison      jsonb,
  report          jsonb,
  ai              text check (ai in ('local', 'cloud')),
  cost_jpy        numeric,
  file_ids        text[] not null default '{}',
  -- 材料を集める業務の実行（第43.5節。始めた人の権限で、会社の AI の方針に従って動く）
  gather_run_id   text,
  -- 討論のあとに頼まれたこと（続ける・掘り下げる）。ワーカーが受け取って空にする
  pending         jsonb,
  stop_requested  boolean not null default false,
  -- ワーカーが動かしている印（止まったワーカーの相談は、別のワーカーが続きから受け持つ）
  worker_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  trashed_at      timestamptz,
  rev             bigint not null default nextval('decision_rev')
);
create index if not exists decision_sessions_tenant on decision_sessions (tenant_id, created_by, updated_at desc);
create index if not exists decision_sessions_work on decision_sessions (status) where status in ('queued', 'gathering', 'debating', 'summarizing');

create table if not exists decision_materials (
  tenant_id   text not null references tenants(id) on delete cascade,
  session_id  text not null references decision_sessions(id) on delete cascade,
  no          integer not null,
  kind        text not null check (kind in ('attachment', 'company', 'knowledge', 'data', 'drive', 'human')),
  title       text not null default '',
  source      text not null default '',
  summary     text not null default '',
  ok          boolean not null default true,
  rev         bigint not null default nextval('decision_rev'),
  primary key (session_id, no)
);

create table if not exists decision_turns (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  session_id  text not null references decision_sessions(id) on delete cascade,
  debate      integer not null default 1,
  seq         integer not null,
  turn        integer not null default 0,
  stage       text not null check (stage in ('main', 'dig', 'summary', 'compare', 'report')),
  issue       text,
  role        text not null check (role in ('con', 'pro', 'judge', 'human')),
  text        text not null default '',
  done        boolean not null default false,
  stopped     boolean not null default false,
  rewritten   boolean not null default false,
  created_at  timestamptz not null default now(),
  done_at     timestamptz,
  rev         bigint not null default nextval('decision_rev')
);
create index if not exists decision_turns_session on decision_turns (session_id, rev);

create table if not exists decision_claims (
  tenant_id    text not null references tenants(id) on delete cascade,
  session_id   text not null references decision_sessions(id) on delete cascade,
  code         text not null,
  debate       integer not null default 1,
  turn_id      text not null,
  role         text not null check (role in ('con', 'pro', 'human')),
  issue        text not null default '',
  kind         text not null check (kind in ('new', 'rebut', 'counter', 'support', 'concede', 'revise')),
  target       text,
  grounds      jsonb not null default '[]',
  gist         text not null default '',
  body         text not null default '',
  state        text not null default 'standing' check (state in ('standing', 'refuted', 'conceded', 'unanswered')),
  state_reason text not null default '',
  refuted_by   text,
  pivot        boolean not null default false,
  rev          bigint not null default nextval('decision_rev'),
  primary key (session_id, code)
);
create index if not exists decision_claims_session on decision_claims (session_id, rev);

create table if not exists decision_issue_states (
  tenant_id   text not null references tenants(id) on delete cascade,
  session_id  text not null references decision_sessions(id) on delete cascade,
  debate      integer not null default 1,
  issue       text not null,
  at          text not null,
  label       text not null default '',
  lean        text not null check (lean in ('con', 'pro', 'even', 'open')),
  changed_by  text,
  reason      text not null default '',
  rev         bigint not null default nextval('decision_rev'),
  primary key (session_id, debate, issue, at)
);

create table if not exists decision_shares (
  tenant_id   text not null references tenants(id) on delete cascade,
  session_id  text not null references decision_sessions(id) on delete cascade,
  user_id     text not null,
  shared_by   text not null,
  created_at  timestamptz not null default now(),
  primary key (session_id, user_id)
);

do $$
declare t text;
begin
  foreach t in array array['decision_sessions', 'decision_materials', 'decision_turns', 'decision_claims', 'decision_issue_states', 'decision_shares'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
    execute format('grant select, insert, update, delete on %I to m2office_app', t);
  end loop;
end $$;
