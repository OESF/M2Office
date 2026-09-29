-- 人事・給与の段 1（土台）。仕様書 第30章・第30.26.1節、ADR-0049
--
-- 内蔵の拡張（既定は切り）。会社の設定は tenant_settings.hr に持つ。
-- 従業員は M2Office の利用者とは別に持つ（アカウントの無いパート・アルバイトも載る。第30.3節）。
-- 雇用条件は変わるたびに行を足す履歴（適用日つき）。手続きの一覧は入社日・退職日から決まったプログラムで作る（第30.5.2節）。

alter table tenant_settings add column if not exists hr jsonb;

create table if not exists hr_employees (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  code          text not null default '',
  name          text not null,
  kana          text not null default '',
  birth_date    date,
  gender        text not null default '' check (gender in ('', 'male', 'female', 'other')),
  address       text not null default '',
  phone         text not null default '',
  email         text not null default '',
  hired_on      date,
  left_on       date,
  leave_reason  text not null default '',
  employment    text not null default 'regular' check (employment in ('regular', 'contract', 'part', 'arbeit', 'officer')),
  category      text not null default 'employee' check (category in ('employee', 'officer', 'family', 'owner')),
  department    text not null default '',
  title         text not null default '',
  user_id       text references users(id) on delete set null,
  status        text not null default 'active' check (status in ('active', 'left')),
  note          text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    text
);
create index if not exists hr_employees_tenant_idx on hr_employees (tenant_id, status, kana);
-- 社員番号は会社の中で重ならない（空は除く）
create unique index if not exists hr_employees_code_idx on hr_employees (tenant_id, code) where code <> '';
-- 1 人の利用者は 1 人の従業員にだけ結び付く
create unique index if not exists hr_employees_user_idx on hr_employees (tenant_id, user_id) where user_id is not null;

create table if not exists hr_terms (
  id                     text primary key,
  tenant_id              text not null references tenants(id) on delete cascade,
  employee_id            text not null references hr_employees(id) on delete cascade,
  effective_on           date not null,
  contract_start         date,
  contract_end           date,
  renewal                text not null default '',
  probation_until        date,
  weekly_hours           numeric(6, 2),
  weekly_days            numeric(4, 2),
  start_time             text not null default '',
  end_time               text not null default '',
  break_minutes          integer,
  wage_type              text not null default 'monthly' check (wage_type in ('monthly', 'daily', 'hourly')),
  wage_amount            numeric(12, 0),
  allowances             jsonb not null default '[]'::jsonb,
  workplace              text not null default '',
  work                   text not null default '',
  workplace_scope        text not null default '',
  work_scope             text not null default '',
  social_insurance       boolean not null default false,
  employment_insurance   boolean not null default false,
  created_by             text,
  created_at             timestamptz not null default now()
);
create index if not exists hr_terms_employee_idx on hr_terms (tenant_id, employee_id, effective_on desc, created_at desc);

create table if not exists hr_tasks (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  employee_id  text not null references hr_employees(id) on delete cascade,
  kind         text not null check (kind in ('hire', 'leave')),
  code         text not null,
  title        text not null,
  due_on       date,
  done_at      timestamptz,
  done_by      text,
  created_at   timestamptz not null default now(),
  unique (tenant_id, employee_id, kind, code)
);
create index if not exists hr_tasks_open_idx on hr_tasks (tenant_id, due_on) where done_at is null;

do $$
declare t text;
begin
  foreach t in array array['hr_employees', 'hr_terms', 'hr_tasks'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
  end loop;
end $$;

-- 台帳は消さない（法定の保存の期間がある。消し方は Q-134）。退職は状態で表す
grant select, insert, update on hr_employees, hr_tasks to m2office_app;
-- 雇用条件は履歴。足すだけで、書き換えない（誤りは新しい行で直す）
grant select, insert on hr_terms to m2office_app;
