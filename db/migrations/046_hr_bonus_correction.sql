-- 人事・給与の Phase 2 段 1（賞与と訂正）。仕様書 第30.11.1節・第30.10.4節
--
-- 賞与の回の入力（支払日・計算期間・人ごとの額）、回ごと・人ごとの調整の行、訂正の回の元の回、
-- 明細の計算の控え（社会保険料等を引いた後の額・標準賞与額。次の賞与の税と上限に使う）。

create table if not exists pay_bonus_plans (
  tenant_id    text not null references tenants(id) on delete cascade,
  pay_month    text not null check (pay_month ~ '^[0-9]{4}-[0-9]{2}$'),
  pay_date     date not null,
  -- 賞与の計算期間が 6 か月を超えるか（前の月の給与が無いときの税の計算で ÷12 にする）
  long_period  boolean not null default false,
  -- 人ごとの賞与の額（従業員の ID → 円）
  amounts      jsonb not null default '{}'::jsonb,
  updated_by   text,
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, pay_month)
);

create table if not exists pay_adjustments (
  id             text primary key,
  tenant_id      text not null references tenants(id) on delete cascade,
  employee_id    text not null references hr_employees(id) on delete cascade,
  kind           text not null check (kind in ('monthly', 'bonus')),
  pay_month      text not null check (pay_month ~ '^[0-9]{4}-[0-9]{2}$'),
  label          text not null,
  direction      text not null check (direction in ('pay', 'deduct')),
  amount         integer not null check (amount > 0),
  -- 所得税の対象か・雇用保険の賃金に入れるか（社会保険の報酬には入れない）
  taxable        boolean not null default true,
  insurable      boolean not null default true,
  reason         text not null default '',
  source         text not null default 'manual' check (source in ('manual', 'correction')),
  source_run_id  text,
  created_by     text,
  created_at     timestamptz not null default now()
);
create index if not exists pay_adjustments_month_idx on pay_adjustments (tenant_id, kind, pay_month);

alter table pay_runs add column if not exists source_run_id text;
alter table pay_slips add column if not exists meta jsonb not null default '{}'::jsonb;

do $$
declare t text;
begin
  foreach t in array array['pay_bonus_plans', 'pay_adjustments'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
  end loop;
end $$;

grant select, insert, update, delete on pay_bonus_plans, pay_adjustments to m2office_app;
