-- 業務と秘書をつなぐイベント（アウトボックス）。仕様書 第10.13節、ADR-0039
--
-- 業務の実行の終了・承認待ちと、秘書との会話の保存を、同じトランザクションの中でトリガーが書く。
-- ワーカーの秘書の受け手が 1 件ずつ確保して処理し、依頼した本人の秘書がその場で学ぶ。
create table if not exists agent_events (
  id               text primary key default gen_random_uuid()::text,
  tenant_id        text not null references tenants(id) on delete cascade,
  -- 持ち主（業務を依頼した人・会話した人）。この人の秘書だけが受け取る
  user_id          text not null,
  -- run.finished / run.awaiting_approval / conversation.turn
  kind             text not null,
  run_id           text,
  conversation_id  text,
  -- 実行の状態（completed / failed / cancelled / awaiting_approval）
  status           text,
  created_at       timestamptz not null default now(),
  -- 確保した回数と、ほかのワーカーに渡さない期限（失敗したらこの時刻のあとにやり直す）
  attempts         integer not null default 0,
  locked_until     timestamptz,
  processed_at     timestamptz,
  last_error       text
);
create index if not exists agent_events_pending_idx on agent_events (created_at) where processed_at is null;
create index if not exists agent_events_tenant_idx on agent_events (tenant_id, created_at desc);

alter table agent_events enable row level security;
drop policy if exists tenant_isolation on agent_events;
create policy tenant_isolation on agent_events
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, update, delete on agent_events to m2office_app;

-- 実行の状態が変わったら書く。依頼した人はジョブから引く
create or replace function m2o_emit_run_event() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  requester text;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if new.status not in ('completed', 'failed', 'cancelled', 'awaiting_approval') then
    return new;
  end if;
  select requested_by into requester from jobs where id = new.job_id;
  if requester is null then
    return new;
  end if;
  insert into agent_events (tenant_id, user_id, kind, run_id, status)
  values (new.tenant_id, requester,
          case when new.status = 'awaiting_approval' then 'run.awaiting_approval' else 'run.finished' end,
          new.id, new.status);
  return new;
end $$;

drop trigger if exists runs_emit_event on runs;
create trigger runs_emit_event after update of status on runs
  for each row execute function m2o_emit_run_event();

-- 秘書との会話を 1 往復残したら書く（「会話を残す」を切っている人は、会話が残らないので書かれない）
create or replace function m2o_emit_conversation_event() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  insert into agent_events (tenant_id, user_id, kind, conversation_id)
  values (new.tenant_id, new.user_id, 'conversation.turn', new.id);
  return new;
end $$;

drop trigger if exists conversations_emit_event on conversations;
create trigger conversations_emit_event after insert on conversations
  for each row execute function m2o_emit_conversation_event();

-- 次に処理するイベントを 1 件確保する。会社をまたいで見るのはこの関数だけ（第20.5節）
create or replace function m2o_claim_agent_event() returns table (id text, tenant_id text)
  language sql security definer set search_path = public as $$
  update agent_events e
     set attempts = e.attempts + 1, locked_until = now() + interval '2 minutes'
   where e.id = (
     select x.id from agent_events x
      where x.processed_at is null and x.attempts < 5
        and (x.locked_until is null or x.locked_until < now())
      order by x.created_at asc
      for update skip locked limit 1
   )
  returning e.id, e.tenant_id;
$$;
revoke all on function m2o_claim_agent_event() from public;
grant execute on function m2o_claim_agent_event() to m2office_app;
