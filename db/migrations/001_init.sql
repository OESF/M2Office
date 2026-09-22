-- M2Office 初期スキーマ
-- 仕様書 第19.1節 主要エンティティに対応する。
-- すべての業務テーブルは tenant_id を持ち、問い合わせは必ずこれで絞る（不変則 I-2）。

create table if not exists tenants (
  id                text primary key,
  subdomain         text not null unique,
  name              text not null,
  workspace_domain  text,
  status            text not null default 'trial',
  created_at        timestamptz not null default now()
);

create table if not exists users (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  email         text not null,
  display_name  text not null,
  roles         text[] not null default '{}',
  status        text not null default 'active',
  created_at    timestamptz not null default now(),
  unique (tenant_id, email)
);

-- 権限区画（仕様書 第16.3節）。HR を最初の区画として用いる。
create table if not exists compartments (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  name        text not null,
  description text,
  enabled     boolean not null default true,
  unique (tenant_id, name)
);

create table if not exists compartment_members (
  compartment_id text not null references compartments(id) on delete cascade,
  user_id        text not null references users(id) on delete cascade,
  assigned_by    text not null,
  assigned_at    timestamptz not null default now(),
  primary key (compartment_id, user_id)
);

create table if not exists jobs (
  id             text primary key,
  tenant_id      text not null references tenants(id) on delete cascade,
  agent_id       text not null,
  agent_version  integer not null,
  requested_by   text not null,
  origin         text not null,
  input          jsonb not null default '{}',
  created_at     timestamptz not null default now()
);
create index if not exists jobs_tenant_idx on jobs (tenant_id, created_at desc);

create table if not exists runs (
  id              text primary key,
  job_id          text not null references jobs(id) on delete cascade,
  tenant_id       text not null references tenants(id) on delete cascade,
  status          text not null,
  cursor          integer not null default 0,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  tokens_used     integer not null default 0,
  cost_jpy        numeric(12,2) not null default 0,
  failure_reason  text
);
create index if not exists runs_tenant_idx on runs (tenant_id, started_at desc);
-- ワーカーが待ち行列から取り出すための索引
create index if not exists runs_queue_idx on runs (status, started_at) where status = 'queued';

create table if not exists run_steps (
  id          text primary key,
  run_id      text not null references runs(id) on delete cascade,
  seq         integer not null,
  step_id     text not null,
  kind        text not null,
  status      text not null,
  input       jsonb,
  output      jsonb,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz
);
create index if not exists run_steps_run_idx on run_steps (run_id, seq);

create table if not exists approvals (
  id             text primary key,
  run_step_id    text not null references run_steps(id) on delete cascade,
  tenant_id      text not null references tenants(id) on delete cascade,
  approver_role  text[] not null default '{}',
  present        text not null,
  decision       text,
  decided_by     text,
  comment        text,
  decided_at     timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists approvals_pending_idx
  on approvals (tenant_id, created_at) where decision is null;

create table if not exists artifacts (
  id          text primary key,
  run_id      text not null references runs(id) on delete cascade,
  tenant_id   text not null references tenants(id) on delete cascade,
  kind        text not null,
  title       text not null,
  body        text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists artifacts_run_idx on artifacts (tenant_id, run_id);

-- 組織知識（仕様書 第11.1節）。compartment が区画を表し、null は区画外。
create table if not exists knowledge_items (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  kind         text not null,
  title        text not null,
  body         text not null,
  source       text not null,
  compartment  text,
  updated_at   timestamptz not null default now()
);
create index if not exists knowledge_tenant_idx on knowledge_items (tenant_id, updated_at desc);

-- 監査ログ（仕様書 第16.6節）。追記のみ。更新と削除は行わない。
create table if not exists audit_events (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  actor_type   text not null,
  actor_id     text not null,
  action       text not null,
  target_type  text not null,
  target_id    text not null,
  detail       jsonb not null default '{}',
  occurred_at  timestamptz not null default now()
);
create index if not exists audit_tenant_idx on audit_events (tenant_id, occurred_at desc);
