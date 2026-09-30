-- 人事・給与: 労働条件通知書と労務カレンダー。仕様書 第30.5.3節・第30.19.1節
--
-- 雇用条件に「更新の上限」（2024 年 4 月の改正の明示事項）を足し、労務カレンダーの期限を二度知らせないための記録を作る。

alter table hr_terms add column if not exists renewal_limit text not null default '';

create table if not exists hr_calendar_alerts (
  tenant_id  text not null references tenants(id) on delete cascade,
  key        text not null,
  sent_at    timestamptz not null default now(),
  primary key (tenant_id, key)
);

alter table hr_calendar_alerts enable row level security;
drop policy if exists tenant_isolation on hr_calendar_alerts;
create policy tenant_isolation on hr_calendar_alerts using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert on hr_calendar_alerts to m2office_app;
