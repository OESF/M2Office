-- 人事・給与の Phase 2 段 3（社会保険）。仕様書 第30.12.1節
--
-- 届出の下書き（算定基礎届・月額変更届・資格取得届・資格喪失届・70 歳到達届）を作った記録。
-- 人ごと・届出の種類ごと・対象（適用の月か喪失の日）ごとに 1 つ。作り直すと置き換える。
-- 下書きを作った額を、適用の月からの標準報酬月額として hr_standard_pay に入れる（2026-09-30 に決定）。
-- 給与の情報に、被保険者整理番号・学生か・資格取得のときの見込みの時間外手当を足す（insurance）。
-- マイナンバー・基礎年金番号は持たない（第30.26.2節）。

create table if not exists hr_insurance_filings (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  employee_id   text not null references hr_employees(id) on delete cascade,
  kind          text not null check (kind in ('regular', 'change', 'acquire', 'lose', 'age70')),
  target        text not null check (target ~ '^[0-9]{4}-[0-9]{2}(-[0-9]{2})?$'),
  data          jsonb not null default '{}'::jsonb,
  created_by    text,
  created_at    timestamptz not null default now(),
  unique (tenant_id, employee_id, kind, target)
);
create index if not exists hr_insurance_filings_kind_idx on hr_insurance_filings (tenant_id, kind, target);

alter table hr_insurance_filings enable row level security;
drop policy if exists tenant_isolation on hr_insurance_filings;
create policy tenant_isolation on hr_insurance_filings using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update on hr_insurance_filings to m2office_app;

alter table hr_payroll_profiles add column if not exists insurance jsonb not null default '{}'::jsonb;
