-- 会社の営業日（仕様書 第6.6.1節・第9.5.5.1節・第35.7節。第 0.243.0 版）
-- 1. 休業の期間（お知らせの作成で出した休業のお知らせから覚える）。朝のブリーフなど「会社の営業日」の定時実行は、この期間には動かない
create table if not exists business_closures (
  id               text primary key,
  tenant_id        text not null references tenants(id) on delete cascade,
  start_date       date not null,
  end_date         date not null,
  announcement_id  text references announcements(id) on delete set null,
  created_at       timestamptz not null default now(),
  check (end_date >= start_date)
);
create index if not exists business_closures_tenant on business_closures (tenant_id, start_date);
alter table business_closures enable row level security;
drop policy if exists tenant_isolation on business_closures;
create policy tenant_isolation on business_closures using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on business_closures to m2office_app;

-- 2. 朝のブリーフの定時実行を「毎平日（月〜金）」から「会社の営業日」にする（営業日の既定は月〜金・祝日は休みのため、平日の回はそのまま）
update schedules set rule = jsonb_set(rule, '{kind}', '"business"')
  where agent_id = 'morning-brief' and rule->>'kind' = 'weekdays';
