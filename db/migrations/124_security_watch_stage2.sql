-- 不正の兆しの見張りの段 2（仕様書 第16.8.4節・第16.8.5節・第23.8.3節。第 0.334.0 版）
--
-- 1. 開いた数: 名刺・問い合わせ・会員・契約・従業員を開いた数を、人と 1 時間ごとの件数だけで数える。どの記録を開いたかは持たない。7 日で消す
-- 2. 運営の「要対応」: 会社ごとの、この 24 時間の兆しの数（数と重いものの数だけ。中身・人は返さない）

create table if not exists security_view_counts (
  tenant_id  text not null references tenants(id) on delete cascade,
  user_id    text not null,
  -- 1 時間の始まり
  hour       timestamptz not null,
  -- contact・inquiry・member・contract・hr_employee
  kind       text not null,
  n          integer not null default 0,
  primary key (tenant_id, user_id, hour, kind)
);
create index if not exists security_view_counts_hour_idx on security_view_counts (tenant_id, hour);

alter table security_view_counts enable row level security;
drop policy if exists tenant_isolation on security_view_counts;
create policy tenant_isolation on security_view_counts using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on security_view_counts to m2office_app;

-- 運営: 会社ごとの、この 24 時間の兆しの数（第23.8.3節「要対応」の異常検知の件数）。既存の ops.tenant_overview の形は変えない
create or replace function ops.tenant_security()
  returns table (tenant_id text, signals_24h integer, high_24h integer)
  language sql stable security definer set search_path = pg_catalog, public as $$
  select s.tenant_id, count(*)::int, count(*) filter (where s.severity = 'high')::int
    from security_signals s
   where s.created_at >= now() - interval '24 hours'
   group by s.tenant_id;
$$;
revoke all on function ops.tenant_security() from public;
grant execute on function ops.tenant_security() to m2office_ops;
