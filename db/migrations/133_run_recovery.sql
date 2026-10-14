-- 止まった実行の再開（仕様書 第9.3節・第17章「実行の再開」。第 0.358.0 版）
--
-- ワーカーは実行を進めている間、30 秒おきに heartbeat_at を付ける。印が古いまま running の実行は、ワーカーが途中で止まったものとみなし、
-- 止まった段から続けるために queued へ戻す。何度も止まる実行は回し続けず、recoveries が上限に達したら failed にする。
alter table runs add column if not exists heartbeat_at timestamptz;
alter table runs add column if not exists recoveries integer not null default 0;
create index if not exists runs_running_idx on runs (heartbeat_at) where status = 'running';

-- 取り出したときにも印を付ける（取り出した直後に止まったとみなされないように）
create or replace function m2o_claim_next_run() returns setof runs
  language sql security definer set search_path = public as $$
  update runs set status = 'running', heartbeat_at = now()
   where id = (
     select r.id from runs r
       join tenants t on t.id = r.tenant_id
      where r.status = 'queued' and t.status in ('trial', 'active')
      order by r.started_at asc for update of r skip locked limit 1
   )
  returning *;
$$;

-- 止まった実行を探して戻す。テナントを横断して探すのはこの関数だけに閉じ込める（待ち行列の取り出しと同じ）
create or replace function m2o_recover_stale_runs(p_before timestamptz, p_max integer)
  returns table (id text, tenant_id text, resumed boolean)
  language sql security definer set search_path = public as $$
  with stale as (
    update runs r
       set status = case when r.recoveries < p_max then 'queued' else 'failed' end,
           recoveries = r.recoveries + 1,
           ended_at = case when r.recoveries < p_max then null else now() end,
           failure_reason = case when r.recoveries < p_max then r.failure_reason else '作業が途中で止まり、続けられませんでした' end
     where r.status = 'running' and coalesce(r.heartbeat_at, r.started_at) < p_before
    returning r.id, r.tenant_id, r.status
  ), closed as (
    -- 動きの途中だった段を、終わらなかった段として閉じる（秘書のバーが古い段の経過時間を数え続けないように）
    update run_steps s
       set status = 'failed', output = coalesce(s.output, '{"error":"作業が途中で止まりました"}'::jsonb), ended_at = now()
      from stale
     where s.run_id = stale.id and s.status = 'running'
    returning s.id
  )
  select stale.id, stale.tenant_id, stale.status = 'queued' from stale;
$$;

revoke all on function m2o_recover_stale_runs(timestamptz, integer) from public;
grant execute on function m2o_recover_stale_runs(timestamptz, integer) to m2office_app;
