-- 人事・給与の段 2（勤怠と休暇）。仕様書 第30.6.1節・第30.7.1節
--
-- 打刻は消さない。直すときは前の打刻に replaced_at を入れ、新しい打刻を足す（直した記録を残す）。
-- 日と月の集計は打刻から決まったプログラムで出し、締めたときの集計だけを att_closes に残す（段 3 の給与の計算に使う）。

create table if not exists att_punches (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  employee_id  text not null references hr_employees(id) on delete cascade,
  kind         text not null check (kind in ('in', 'out', 'break_start', 'break_end')),
  at           timestamptz not null,
  source       text not null default 'screen' check (source in ('screen', 'mobile', 'secretary', 'fix', 'import')),
  created_by   text,
  created_at   timestamptz not null default now(),
  replaced_at  timestamptz,
  replaced_by  text
);
create index if not exists att_punches_employee_idx on att_punches (tenant_id, employee_id, at) where replaced_at is null;

create table if not exists att_closes (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  period_start  date not null,
  period_end    date not null,
  status        text not null default 'closed' check (status in ('closed', 'reopened')),
  totals        jsonb not null default '{}'::jsonb,
  closed_by     text,
  closed_at     timestamptz not null default now(),
  reopened_by   text,
  reopened_at   timestamptz
);
-- 同じ期間を二重に締めない
create unique index if not exists att_closes_period_idx on att_closes (tenant_id, period_end) where status = 'closed';

create table if not exists leave_grants (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  employee_id  text not null references hr_employees(id) on delete cascade,
  granted_on   date not null,
  days         numeric(5, 1) not null check (days >= 0),
  expires_on   date not null,
  basis        text not null default 'auto' check (basis in ('auto', 'manual')),
  note         text not null default '',
  created_by   text,
  created_at   timestamptz not null default now(),
  unique (tenant_id, employee_id, granted_on)
);

create table if not exists leave_takes (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  employee_id   text not null references hr_employees(id) on delete cascade,
  date          date not null,
  days          numeric(3, 1) not null check (days in (0.5, 1)),
  status        text not null default 'taken' check (status in ('taken', 'cancelled')),
  source        text not null default 'screen' check (source in ('screen', 'secretary', 'staff')),
  note          text not null default '',
  created_by    text,
  created_at    timestamptz not null default now(),
  cancelled_by  text,
  cancelled_at  timestamptz
);
-- 同じ日に二重に取らない（取り消したものは除く）
create unique index if not exists leave_takes_day_idx on leave_takes (tenant_id, employee_id, date) where status = 'taken';

-- 知らせを同じ段階で二度送らないための印（36 協定・取得義務）
create table if not exists hr_alerts (
  tenant_id    text not null references tenants(id) on delete cascade,
  employee_id  text not null references hr_employees(id) on delete cascade,
  key          text not null,
  sent_at      timestamptz not null default now(),
  primary key (tenant_id, employee_id, key)
);

do $$
declare t text;
begin
  foreach t in array array['att_punches', 'att_closes', 'leave_grants', 'leave_takes', 'hr_alerts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
  end loop;
end $$;

-- 打刻と付与と取得は消さない（直す・取り消すは印を付ける）
grant select, insert, update on att_punches, att_closes, leave_grants, leave_takes to m2office_app;
grant select, insert on hr_alerts to m2office_app;
