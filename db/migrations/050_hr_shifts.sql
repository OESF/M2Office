-- 人事・給与の Phase 2 段 5（シフトと 1 か月単位の変形労働時間制）。仕様書 第30.6.2節
--
-- 雇用条件に働き方（固定かシフトか）を足す。シフトの人は、その日のシフトを所定の始業・終業とする。
-- シフトは締めの期間ごとに組む（案を作り、担当者が直して公開する）。本人は休みの希望を出す。
-- 勤務の型と日ごとに要る人数は会社の設定（hr.shift）に持つ。

alter table hr_terms add column if not exists schedule text not null default 'fixed';
alter table hr_terms drop constraint if exists hr_terms_schedule_check;
alter table hr_terms add constraint hr_terms_schedule_check check (schedule in ('fixed', 'shift'));

create table if not exists hr_shift_plans (
  tenant_id     text not null references tenants(id) on delete cascade,
  period_start  date not null,
  period_end    date not null,
  status        text not null default 'draft' check (status in ('draft', 'published')),
  generated_at  timestamptz,
  published_at  timestamptz,
  published_by  text,
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, period_start)
);

create table if not exists hr_shifts (
  tenant_id     text not null references tenants(id) on delete cascade,
  employee_id   text not null references hr_employees(id) on delete cascade,
  date          date not null,
  -- 勤務の型の ID（休みは null）。時刻は型から写して持つ（型を直しても組んだシフトは変わらない）
  pattern       text,
  start_time    text not null default '',
  end_time      text not null default '',
  break_minutes integer not null default 0,
  -- 公開の後に直した（1 か月単位の変形労働時間制では、始まる前に決めた時間を変えない決まり）
  changed_after_publish boolean not null default false,
  updated_by    text,
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, employee_id, date)
);
create index if not exists hr_shifts_date_idx on hr_shifts (tenant_id, date);

create table if not exists hr_shift_requests (
  tenant_id     text not null references tenants(id) on delete cascade,
  employee_id   text not null references hr_employees(id) on delete cascade,
  date          date not null,
  note          text not null default '',
  created_at    timestamptz not null default now(),
  primary key (tenant_id, employee_id, date)
);

do $$
declare t text;
begin
  foreach t in array array['hr_shift_plans', 'hr_shifts', 'hr_shift_requests'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
  end loop;
end $$;
-- 案を作り直すと期間のシフトを置き換える（消して入れ直す）
grant select, insert, update on hr_shift_plans to m2office_app;
grant select, insert, update, delete on hr_shifts, hr_shift_requests to m2office_app;
