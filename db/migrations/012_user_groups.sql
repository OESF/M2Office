-- グループと利用範囲（仕様書 第16.7節）
-- 1. 業務ごとの利用範囲は会社の設定の区分 access に持つ
alter table tenant_settings add column if not exists access jsonb;

-- 2. グループ。名前は会社の中で重ならない
create table if not exists user_groups (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  name         text not null,
  description  text not null default '',
  created_at   timestamptz not null default now(),
  unique (tenant_id, name)
);

-- 3. 所属。1 人が複数のグループに入れる
create table if not exists user_group_members (
  tenant_id  text not null references tenants(id) on delete cascade,
  group_id   text not null references user_groups(id) on delete cascade,
  user_id    text not null references users(id) on delete cascade,
  primary key (group_id, user_id)
);
create index if not exists user_group_members_user on user_group_members (tenant_id, user_id);

alter table user_groups enable row level security;
drop policy if exists tenant_isolation on user_groups;
create policy tenant_isolation on user_groups
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on user_groups to m2office_app;

alter table user_group_members enable row level security;
drop policy if exists tenant_isolation on user_group_members;
create policy tenant_isolation on user_group_members
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on user_group_members to m2office_app;
