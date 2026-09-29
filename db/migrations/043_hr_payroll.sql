-- 人事・給与の段 3（給与の計算）。仕様書 第30.10.1節・第30.10.2節・第30.24節
--
-- 従業員ごとの給与の情報（税の区分・扶養の数・住民税・通勤・口座）、標準報酬月額の履歴、家族、給与の回と明細（下書き）。
-- 法令の表は本体のデータのファイルに持つ（テナントを持たない。第30.10.2節）ため、ここには作らない。
-- 明細の行には根拠（表の版・等級・料率・集計・端数処理）を持つ（H-4）。

create table if not exists hr_payroll_profiles (
  employee_id    text primary key references hr_employees(id) on delete cascade,
  tenant_id      text not null references tenants(id) on delete cascade,
  tax_column     text not null default 'ko' check (tax_column in ('ko', 'otsu')),
  dependents     integer not null default 0 check (dependents between 0 and 20),
  resident_tax   jsonb not null default '[]'::jsonb,
  commute        jsonb not null default '{}'::jsonb,
  bank           jsonb not null default '{}'::jsonb,
  updated_by     text,
  updated_at     timestamptz not null default now()
);

create table if not exists hr_standard_pay (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  employee_id   text not null references hr_employees(id) on delete cascade,
  from_month    text not null check (from_month ~ '^[0-9]{4}-[0-9]{2}$'),
  amount        integer not null check (amount > 0),
  kind          text not null default 'manual' check (kind in ('acquire', 'regular', 'change', 'manual')),
  created_by    text,
  created_at    timestamptz not null default now()
);
create index if not exists hr_standard_pay_employee_idx on hr_standard_pay (tenant_id, employee_id, from_month desc);

create table if not exists hr_family (
  id              text primary key,
  tenant_id       text not null references tenants(id) on delete cascade,
  employee_id     text not null references hr_employees(id) on delete cascade,
  name            text not null,
  relation        text not null default '',
  birth_date      date,
  cohabiting      boolean not null default true,
  income_estimate integer,
  dependent       boolean not null default false,
  created_at      timestamptz not null default now()
);
create index if not exists hr_family_employee_idx on hr_family (tenant_id, employee_id);

create table if not exists pay_runs (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  kind          text not null default 'monthly' check (kind in ('monthly', 'bonus', 'yea', 'correction')),
  pay_month     text not null check (pay_month ~ '^[0-9]{4}-[0-9]{2}$'),
  pay_date      date not null,
  period_start  date not null,
  period_end    date not null,
  status        text not null default 'draft' check (status in ('draft', 'checked', 'confirmed', 'paid')),
  law           jsonb not null default '{}'::jsonb,
  warnings      jsonb not null default '[]'::jsonb,
  calculated_by text,
  calculated_at timestamptz not null default now()
);
-- 同じ支給月の月の給与の下書きは 1 つ（計算し直すと置き換える）
create unique index if not exists pay_runs_month_idx on pay_runs (tenant_id, kind, pay_month) where status = 'draft';

create table if not exists pay_slips (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  run_id        text not null references pay_runs(id) on delete cascade,
  employee_id   text not null references hr_employees(id) on delete cascade,
  gross         integer not null,
  deductions    integer not null,
  net           integer not null,
  lines         jsonb not null default '[]'::jsonb,
  warnings      jsonb not null default '[]'::jsonb,
  unique (run_id, employee_id)
);

do $$
declare t text;
begin
  foreach t in array array['hr_payroll_profiles', 'hr_standard_pay', 'hr_family', 'pay_runs', 'pay_slips'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
  end loop;
end $$;

grant select, insert, update on hr_payroll_profiles, hr_standard_pay to m2office_app;
grant select, insert, update, delete on hr_family to m2office_app;
-- 下書きの回は計算し直すたびに置き換える（確定した回は段 4 で書き換えを禁じる）
grant select, insert, update, delete on pay_runs, pay_slips to m2office_app;
