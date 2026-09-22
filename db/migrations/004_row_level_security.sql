-- 行レベルセキュリティ（仕様書 第8.5.5節）
--
-- アプリは m2office_app ロールで接続する。このロールは表の所有者ではなく、
-- RLS を迂回する権限も持たない。スキーマ変更は所有者（移行用ロール）で行う。
--
-- 各トランザクションの中で set_config('app.tenant_id', <id>, true) を設定し、
-- その値に一致する行だけが見える・書ける。設定が無ければ 1 行も見えない。
--
-- ロール m2office_app 自体は scripts/migrate.mjs が作成する（パスワードを SQL に書かないため）。

-- テナントの値を読む。未設定なら null を返し、どの行にも一致しない
create or replace function m2o_current_tenant() returns text
  language sql stable as $$ select nullif(current_setting('app.tenant_id', true), '') $$;

-- tenant_id を直接持つ表
do $$
declare t text;
begin
  foreach t in array array[
    'users', 'compartments', 'jobs', 'runs', 'approvals', 'artifacts', 'knowledge_items',
    'audit_events', 'schedules', 'notifications', 'sessions'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) '
      'with check (tenant_id = m2o_current_tenant())', t);
  end loop;
end $$;

-- tenant_id を持たず、親の表を通じて絞る表。親の表にも RLS が掛かるため、
-- 親が見えない行は子も見えない
alter table run_steps enable row level security;
drop policy if exists tenant_isolation on run_steps;
create policy tenant_isolation on run_steps
  using (exists (select 1 from runs r where r.id = run_steps.run_id))
  with check (exists (select 1 from runs r where r.id = run_steps.run_id));

alter table compartment_members enable row level security;
drop policy if exists tenant_isolation on compartment_members;
create policy tenant_isolation on compartment_members
  using (exists (select 1 from compartments c where c.id = compartment_members.compartment_id))
  with check (exists (select 1 from compartments c where c.id = compartment_members.compartment_id));

-- テナントを横断する処理は 2 つだけであり、所有者の権限で動く関数に閉じ込める。
-- アプリは表を直接横断できない

-- 待ち行列から実行を 1 件確保する（ワーカー用）
create or replace function m2o_claim_next_run() returns setof runs
  language sql security definer set search_path = public as $$
  update runs set status = 'running'
   where id = (
     select id from runs where status = 'queued'
      order by started_at asc for update skip locked limit 1
   )
  returning *;
$$;

-- 実行時刻を過ぎた定時実行の候補を返す（ワーカー用）。確保と更新はテナントの範囲で行う
create or replace function m2o_due_schedules(p_now timestamptz, p_limit integer)
  returns table (id text, tenant_id text)
  language sql stable security definer set search_path = public as $$
  select s.id, s.tenant_id from schedules s
   where s.enabled and s.next_run_at <= p_now
   order by s.next_run_at limit p_limit;
$$;

revoke all on function m2o_claim_next_run() from public;
revoke all on function m2o_due_schedules(timestamptz, integer) from public;

-- 権限。監査ログは追記のみとし、更新と削除の権限を与えない（仕様書 第16.6節）
grant usage on schema public to m2office_app;
grant select on tenants to m2office_app;
grant select, insert, update, delete on
  users, compartments, compartment_members, jobs, runs, run_steps, approvals, artifacts,
  knowledge_items, schedules, notifications, sessions
  to m2office_app;
revoke update, delete on audit_events from m2office_app;
grant select, insert on audit_events to m2office_app;
grant execute on function m2o_claim_next_run() to m2office_app;
grant execute on function m2o_due_schedules(timestamptz, integer) to m2office_app;
grant execute on function m2o_current_tenant() to m2office_app;
