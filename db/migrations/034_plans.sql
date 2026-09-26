-- 秘書の段取り（分身と業務の連携）。仕様書 第10.14節、ADR-0040
--
-- 秘書が段取りを作ると、トリガーがイベント plan.requested を書き、ワーカーの分身が段取りを立てて業務を依頼する。
-- 本人が問いに答えて段取りを続けるときは plan.resumed を書く。
create table if not exists plans (
  id              text primary key,
  tenant_id       text not null references tenants(id) on delete cascade,
  -- 依頼した本人。分身はこの人として業務を起こす
  user_id         text not null references users(id) on delete cascade,
  request         text not null,
  -- 段取りを立てる材料（今日の会話・本人の返事）
  context         text not null default '',
  -- planning / running / waiting_input / reported / cancelled
  status          text not null,
  -- 本人に聞いていること（waiting_input のとき）
  question        text,
  report_run_id   text references runs(id) on delete set null,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  finished_at     timestamptz
);
create index if not exists plans_user_idx on plans (tenant_id, user_id, created_at desc);

create table if not exists plan_steps (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  plan_id     text not null references plans(id) on delete cascade,
  -- 1 から始まる順番
  seq         integer not null,
  agent_id    text not null,
  -- この段で頼むこと（依頼の文）
  purpose     text not null,
  -- 先に終わっている必要がある段（seq）
  depends_on  integer[] not null default '{}',
  -- pending / needs_input / running / awaiting_approval / completed / failed / skipped / cancelled
  status      text not null,
  run_id      text references runs(id) on delete set null,
  attempts    integer not null default 0,
  -- 本人に聞いたか（1 回だけ聞く）
  asked       boolean not null default false,
  answer      text,
  note        text,
  updated_at  timestamptz not null default now(),
  unique (plan_id, seq)
);
create index if not exists plan_steps_plan_idx on plan_steps (plan_id, seq);
create index if not exists plan_steps_run_idx on plan_steps (run_id);

-- どの段取りの段として起こした実行か
alter table jobs add column if not exists plan_step_id text references plan_steps(id) on delete set null;

do $$
declare t text;
begin
  foreach t in array array['plans', 'plan_steps'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) '
      'with check (tenant_id = m2o_current_tenant())', t);
    execute format('grant select, insert, update, delete on %I to m2office_app', t);
  end loop;
end $$;

alter table agent_events add column if not exists plan_id text;

-- 段取りを作ったとき（plan.requested）と、本人の返事で続けるとき（plan.resumed）に書く
create or replace function m2o_emit_plan_event() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and new.status = 'planning' then
    insert into agent_events (tenant_id, user_id, kind, plan_id) values (new.tenant_id, new.user_id, 'plan.requested', new.id);
  elsif tg_op = 'UPDATE' and old.status = 'waiting_input' and new.status = 'running' then
    insert into agent_events (tenant_id, user_id, kind, plan_id) values (new.tenant_id, new.user_id, 'plan.resumed', new.id);
  end if;
  return new;
end $$;

drop trigger if exists plans_emit_event on plans;
create trigger plans_emit_event after insert or update of status on plans
  for each row execute function m2o_emit_plan_event();
