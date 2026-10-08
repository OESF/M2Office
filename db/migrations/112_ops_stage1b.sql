-- マスター管理画面の段 1 の 2 回目（仕様書 第23.8.15節・第23.8.14節。第 0.309.0 版）
--
-- 毎晩の数の記録・会社の詳細・サーバー全体の稼働状況・運営主体の設定。
-- 運営のロール（m2office_ops）は、ここでも決めた関数を通してだけ顧客の表の数を読む。返すのは件数・金額・状態と、
-- 会社の詳細のシートの一覧の氏名とロール（第23.8.4節。利用者の名前を出すのはここだけ）。

-- ワーカーが動いていることの知らせ（クラウドの形。ワーカーが 1 分ごとに書く。会社を持たない表）
create table if not exists worker_beats (
  id       text primary key,
  at       timestamptz not null default now(),
  version  text
);
grant select, insert, update, delete on worker_beats to m2office_app;

-- 会社ごとの毎日の数（ワーカーが毎晩、前の日の分を書く）
create table if not exists ops.tenant_daily (
  tenant_id      text not null,
  day            date not null,
  users_active   integer not null default 0,
  users_day      integer not null default 0,
  runs           integer not null default 0,
  runs_failed    integer not null default 0,
  conversations  integer not null default 0,
  ai_cost        numeric(14, 4) not null default 0,
  ai_calls       integer not null default 0,
  files_bytes    bigint not null default 0,
  recorded_at    timestamptz not null default now(),
  primary key (tenant_id, day)
);
grant select on ops.tenant_daily to m2office_ops;

-- 前の日の数を書く（ワーカーがアプリのロールで呼ぶ。数だけを運営の表へ移す）
create or replace function m2o_ops_record_daily(p_day date)
  returns integer
  language sql security definer set search_path = pg_catalog, public, ops as $$
  with b as (
    select p_day::timestamp at time zone 'Asia/Tokyo' as s, (p_day + 1)::timestamp at time zone 'Asia/Tokyo' as e
  ), ins as (
    insert into ops.tenant_daily (tenant_id, day, users_active, users_day, runs, runs_failed, conversations, ai_cost, ai_calls, files_bytes, recorded_at)
    select t.id, p_day,
      (select count(*) from users u where u.tenant_id = t.id and u.status = 'active'),
      (select count(distinct s.user_id) from sessions s where s.tenant_id = t.id and s.last_seen_at >= b.s and s.last_seen_at < b.e),
      (select count(*) from runs r where r.tenant_id = t.id and r.started_at >= b.s and r.started_at < b.e),
      (select count(*) from runs r where r.tenant_id = t.id and r.started_at >= b.s and r.started_at < b.e and r.status = 'failed'),
      (select count(*) from conversations c where c.tenant_id = t.id and c.created_at >= b.s and c.created_at < b.e),
      (select coalesce(sum(a.cost_jpy), 0) from ai_usage a where a.tenant_id = t.id and a.at >= b.s and a.at < b.e),
      (select count(*) from ai_usage a where a.tenant_id = t.id and a.at >= b.s and a.at < b.e),
      (select coalesce(sum(f.size), 0) from files f where f.tenant_id = t.id),
      now()
    from tenants t, b
    on conflict (tenant_id, day) do update set
      users_active = excluded.users_active, users_day = excluded.users_day, runs = excluded.runs, runs_failed = excluded.runs_failed,
      conversations = excluded.conversations, ai_cost = excluded.ai_cost, ai_calls = excluded.ai_calls, files_bytes = excluded.files_bytes,
      recorded_at = excluded.recorded_at
    returning 1
  )
  select count(*)::int from ins;
$$;

-- 会社の詳細（第23.8.15節）。業務の中身は返さない。失敗は業務の種類（業務の ID）と件数だけ（理由の文は中身を含みうる）
create or replace function ops.tenant_detail(p_tenant text)
  returns jsonb
  language sql stable security definer set search_path = pg_catalog, public, ops as $$
  with b as (
    select (date_trunc('month', now() at time zone 'Asia/Tokyo')) at time zone 'Asia/Tokyo' as month,
           now() - interval '30 days' as d30, now() - interval '24 hours' as d1
  )
  select case when t.id is null then null else jsonb_build_object(
    'tenant', jsonb_build_object('id', t.id, 'subdomain', t.subdomain, 'name', t.name, 'workspaceDomain', t.workspace_domain, 'status', t.status, 'createdAt', t.created_at),
    'seats', coalesce((select jsonb_agg(jsonb_build_object(
        'displayName', u.display_name, 'roles', u.roles, 'status', u.status,
        -- 先方の管理者だけ連絡先を出す（第23.8.4節「概要」）
        'email', case when 'admin' = any (u.roles) then u.email else null end,
        'lastUsedAt', (select max(s.last_seen_at) from sessions s where s.tenant_id = t.id and s.user_id = u.id)
      ) order by u.display_name) from users u where u.tenant_id = t.id), '[]'::jsonb),
    'months', coalesce((select jsonb_agg(m order by m->>'month') from (
        select jsonb_build_object('month', to_char(d.day, 'YYYY-MM'), 'runs', sum(d.runs), 'failed', sum(d.runs_failed),
          'conversations', sum(d.conversations), 'aiCost', sum(d.ai_cost), 'usersMax', max(d.users_day)) as m
          from ops.tenant_daily d
         where d.tenant_id = t.id and d.day >= (date_trunc('month', now() at time zone 'Asia/Tokyo') - interval '12 months')::date
           and d.day < (date_trunc('month', now() at time zone 'Asia/Tokyo'))::date
         group by to_char(d.day, 'YYYY-MM')) x), '[]'::jsonb),
    'currentMonth', jsonb_build_object(
      'month', to_char(now() at time zone 'Asia/Tokyo', 'YYYY-MM'),
      'runs', (select count(*) from runs r where r.tenant_id = t.id and r.started_at >= b.month),
      'failed', (select count(*) from runs r where r.tenant_id = t.id and r.started_at >= b.month and r.status = 'failed'),
      'conversations', (select count(*) from conversations c where c.tenant_id = t.id and c.created_at >= b.month),
      'aiCost', (select coalesce(sum(a.cost_jpy), 0) from ai_usage a where a.tenant_id = t.id and a.at >= b.month)),
    'health', jsonb_build_object(
      'runs30d', (select count(*) from runs r where r.tenant_id = t.id and r.started_at >= b.d30),
      'failed30d', (select count(*) from runs r where r.tenant_id = t.id and r.started_at >= b.d30 and r.status = 'failed'),
      'approvalsPending', (select count(*) from approvals a where a.tenant_id = t.id and a.decision is null),
      'approvalsOldest', (select min(a.created_at) from approvals a where a.tenant_id = t.id and a.decision is null),
      'googleConnections', (select count(*) from user_google_connections g where g.tenant_id = t.id),
      'targets', coalesce((select jsonb_agg(jsonb_build_object('target', h.target, 'ok', h.ok, 'fail', h.fail, 'avgMs', h.avg_ms, 'lastError', h.last_error) order by h.target) from (
          select ch.target, sum(ch.ok)::int as ok, sum(ch.fail)::int as fail,
                 case when sum(ch.ok + ch.fail) > 0 then (sum(ch.total_ms) / sum(ch.ok + ch.fail))::int else null end as avg_ms,
                 (array_agg(ch.last_error order by ch.minute desc) filter (where ch.last_error is not null))[1] as last_error
            from connection_health ch where ch.tenant_id = t.id and ch.minute >= b.d1 group by ch.target) h), '[]'::jsonb),
      'failedAgents', coalesce((select jsonb_agg(jsonb_build_object('agentId', f.agent_id, 'count', f.n) order by f.n desc) from (
          select j.agent_id, count(*)::int as n from runs r join jobs j on j.id = r.job_id
           where r.tenant_id = t.id and r.started_at >= b.d30 and r.status = 'failed' group by j.agent_id order by n desc limit 10) f), '[]'::jsonb)),
    'history', coalesce((select jsonb_agg(jsonb_build_object('action', e.action, 'actorId', e.actor_id, 'detail', e.detail, 'occurredAt', e.occurred_at) order by e.occurred_at desc)
        from (select * from audit_events e where e.tenant_id = t.id and e.action like 'tenant.%' order by e.occurred_at desc limit 50) e), '[]'::jsonb)
  ) end
  from b left join tenants t on t.id = p_tenant;
$$;

-- サーバー全体の稼働状況（第23.8.7節のうち段 1 の分）
create or replace function ops.server_status()
  returns jsonb
  language sql stable security definer set search_path = pg_catalog, public, ops as $$
  with b as (
    select (date_trunc('day', now() at time zone 'Asia/Tokyo')) at time zone 'Asia/Tokyo' as today,
           (date_trunc('month', now() at time zone 'Asia/Tokyo')) at time zone 'Asia/Tokyo' as month,
           now() - interval '1 hour' as h1, now() - interval '24 hours' as d1
  )
  select jsonb_build_object(
    'queue', jsonb_build_object(
      'queued', (select count(*) from runs where status = 'queued'),
      'oldestQueuedAt', (select min(started_at) from runs where status = 'queued'),
      'running', (select count(*) from runs where status = 'running'),
      'awaitingApproval', (select count(*) from runs where status = 'awaiting_approval')),
    'runs', jsonb_build_object(
      'hour', (select count(*) from runs where started_at >= b.h1),
      'hourFailed', (select count(*) from runs where started_at >= b.h1 and status = 'failed'),
      'today', (select count(*) from runs where started_at >= b.today),
      'todayFailed', (select count(*) from runs where started_at >= b.today and status = 'failed')),
    'workers', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'at', w.at, 'version', w.version) order by w.at desc) from worker_beats w where w.at >= now() - interval '1 day'), '[]'::jsonb),
    'schedulesLate', (select count(*) from schedules s join tenants t on t.id = s.tenant_id
                       where s.enabled and s.next_run_at < now() - interval '5 minutes' and t.status in ('trial', 'active')),
    'targets', coalesce((select jsonb_agg(jsonb_build_object('group', g.grp, 'ok', g.ok, 'fail', g.fail, 'avgMs', g.avg_ms) order by g.grp) from (
        select split_part(target, ':', 1) as grp, sum(ok)::int as ok, sum(fail)::int as fail,
               case when sum(ok + fail) > 0 then (sum(total_ms) / sum(ok + fail))::int else null end as avg_ms
          from connection_health where minute >= b.d1 group by split_part(target, ':', 1)) g), '[]'::jsonb),
    'database', jsonb_build_object('bytes', pg_database_size(current_database()),
      'connections', (select count(*) from pg_stat_activity where datname = current_database())),
    'filesBytes', (select coalesce(sum(size), 0) from files),
    'ai', jsonb_build_object(
      'today', (select coalesce(sum(cost_jpy), 0) from ai_usage where at >= b.today),
      'month', (select coalesce(sum(cost_jpy), 0) from ai_usage where at >= b.month),
      -- 前の月の同じ時期（月の初めから、1 か月前の今まで）
      'lastMonthSamePeriod', (select coalesce(sum(cost_jpy), 0) from ai_usage where at >= b.month - interval '1 month' and at < now() - interval '1 month'))
  ) from b;
$$;

-- 運営主体の設定（第23.8.14節。配備ごとに 1 つ）
create table if not exists ops.operator_profile (
  id          integer primary key default 1 check (id = 1),
  name_ja     text not null default '',
  name_en     text not null default '',
  address     text not null default '',
  web         text not null default '',
  contact     text not null default '',
  updated_by  text not null default '',
  updated_at  timestamptz not null default now()
);
grant select, insert, update on ops.operator_profile to m2office_ops;

-- 顧客の側が運営主体を読む口（内蔵の拡張の提供者の表記など）。入れていなければ 0 行
create or replace function m2o_operator_profile()
  returns table (name_ja text, name_en text, address text, web text, contact text)
  language sql stable security definer set search_path = pg_catalog, ops as $$
  select name_ja, name_en, address, web, contact from ops.operator_profile where id = 1;
$$;

revoke all on function ops.tenant_detail(text) from public;
revoke all on function ops.server_status() from public;
grant execute on function ops.tenant_detail(text) to m2office_ops;
grant execute on function ops.server_status() to m2office_ops;
-- 毎晩の記録と運営主体の読み出しは、アプリのロールだけが呼ぶ（public の関数の既定。移行 111）
revoke all on function m2o_ops_record_daily(date) from public;
revoke all on function m2o_operator_profile() from public;
grant execute on function m2o_ops_record_daily(date) to m2office_app;
grant execute on function m2o_operator_profile() to m2office_app;
