-- 人事・給与の Phase 2 段 4（労働保険の年度更新）。仕様書 第30.13.1節
--
-- 年度更新の年（申告する年。確定は前の年の 4 月〜その年の 3 月、概算はその年の 4 月〜翌年の 3 月）ごとに 1 つ。
-- M2Office で給与を確定していない月の合計（担当者が入れる）・申告済の概算保険料・見込みの賃金と、
-- 下書きを作ったときの結果（次の年の申告済の概算保険料と、延納の期別の額に使う）を持つ。

create table if not exists hr_labor_insurance (
  tenant_id     text not null references tenants(id) on delete cascade,
  year          integer not null check (year between 2000 and 2100),
  data          jsonb not null default '{}'::jsonb,
  result        jsonb,
  filed_at      timestamptz,
  filed_by      text,
  updated_by    text,
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, year)
);

alter table hr_labor_insurance enable row level security;
drop policy if exists tenant_isolation on hr_labor_insurance;
create policy tenant_isolation on hr_labor_insurance using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update on hr_labor_insurance to m2office_app;
