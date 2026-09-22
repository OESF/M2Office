-- 権限区画の割当をグループで行う（仕様書 第16.7.5節、Q-76）
-- 個人の割当は従来どおり compartment_members に持ち、グループの割当をここに持つ。
-- 区画に入れるのは、割り当てたグループの所属者と、個別に割り当てた者だけ（第16.3.2節）。
create table if not exists compartment_groups (
  tenant_id       text not null references tenants(id) on delete cascade,
  compartment_id  text not null references compartments(id) on delete cascade,
  group_id        text not null references user_groups(id) on delete cascade,
  assigned_by     text not null,
  assigned_at     timestamptz not null default now(),
  primary key (compartment_id, group_id)
);

alter table compartment_groups enable row level security;
drop policy if exists tenant_isolation on compartment_groups;
create policy tenant_isolation on compartment_groups
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on compartment_groups to m2office_app;
