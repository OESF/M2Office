-- テナントの停止（仕様書 第23.8.6節）
-- 状態 suspended（通常の停止）・locked（緊急停止）・cancelled（解約済み）の会社では、
-- 待ち行列の実行を始めず、定時実行を起動しない。実行中の実行は、ワーカーがそのまま完走させる。
-- 定時実行の次の時刻を進めないため、再開したときに止まっていた間の回がまとめて 1 回だけ起動する。
create or replace function m2o_claim_next_run() returns setof runs
  language sql security definer set search_path = public as $$
  update runs set status = 'running'
   where id = (
     select r.id from runs r
       join tenants t on t.id = r.tenant_id
      where r.status = 'queued' and t.status in ('trial', 'active')
      order by r.started_at asc for update of r skip locked limit 1
   )
  returning *;
$$;

create or replace function m2o_due_schedules(p_now timestamptz, p_limit integer)
  returns table (id text, tenant_id text)
  language sql stable security definer set search_path = public as $$
  select s.id, s.tenant_id from schedules s
    join tenants t on t.id = s.tenant_id
   where s.enabled and s.next_run_at <= p_now and t.status in ('trial', 'active')
   order by s.next_run_at limit p_limit;
$$;

revoke all on function m2o_claim_next_run() from public;
revoke all on function m2o_due_schedules(timestamptz, integer) from public;
grant execute on function m2o_claim_next_run() to m2office_app;
grant execute on function m2o_due_schedules(timestamptz, integer) to m2office_app;
