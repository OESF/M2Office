-- 人事・給与の Phase 2 段 2（年末調整）。仕様書 第30.15.1節
--
-- 年ごと・人ごとの年末調整の申告（扶養・配偶者・本人の該当・保険料・住宅借入金等特別控除・前の勤め先）。
-- 本人が画面で出し、担当者が確かめる。マイナンバーは持たない（第30.26.2節）。
-- 精算は種類「年末調整」の回（pay_runs.kind = 'yea'）で行い、不足は翌月の調整の行で差し引く。

create table if not exists yea_declarations (
  tenant_id     text not null references tenants(id) on delete cascade,
  employee_id   text not null references hr_employees(id) on delete cascade,
  year          integer not null check (year between 2000 and 2100),
  data          jsonb not null default '{}'::jsonb,
  submitted_at  timestamptz,
  submitted_by  text,
  checked_at    timestamptz,
  checked_by    text,
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, employee_id, year)
);

alter table yea_declarations enable row level security;
drop policy if exists tenant_isolation on yea_declarations;
create policy tenant_isolation on yea_declarations using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update on yea_declarations to m2office_app;

-- 年末調整の不足を翌月の給与で差し引く調整の行
alter table pay_adjustments drop constraint if exists pay_adjustments_source_check;
alter table pay_adjustments add constraint pay_adjustments_source_check check (source in ('manual', 'correction', 'yea'));
