-- 会員とポイント（内蔵の拡張。仕様書 第40章）。
-- 会員・ポイントの記録・特典を会社ごとに持つ。ポイントの記録は追記のみ（取り消しは逆の記録を足す。在庫の記録と同じ。第29.9節）。
-- 購入の金額は持たない（ポイントだけ。第40.6節）。

alter table tenant_settings add column if not exists members jsonb;

create table if not exists members (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  number        integer not null,
  nickname      text not null check (char_length(nickname) between 1 and 30),
  phone         text not null default '',
  line_user_id  text,
  card_key      text not null unique,
  merged_into   text,
  created_by    text not null,
  created_at    timestamptz not null default now(),
  unique (tenant_id, number)
);
create unique index if not exists members_line on members (tenant_id, line_user_id) where line_user_id is not null and merged_into is null;

create table if not exists member_rewards (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 40),
  points      integer not null check (points between 1 and 100000),
  valid_from  date,
  valid_to    date,
  status      text not null default 'active' check (status in ('active', 'stopped')),
  created_at  timestamptz not null default now()
);

-- 会員を削除しても記録は残す（だれのものかは消える。第40.11節）ため、会員への参照は外部キーにしない
create table if not exists member_points (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  member_id    text not null,
  kind         text not null check (kind in ('visit', 'purchase', 'reward', 'undo', 'expire', 'adjust')),
  points       integer not null,
  reward_id    text,
  reward_name  text not null default '',
  reversal_of  text,
  note         text not null default '',
  local_day    date not null,
  created_by   text not null,
  created_at   timestamptz not null default now()
);
create index if not exists member_points_member on member_points (tenant_id, member_id, created_at);
create unique index if not exists member_points_reversal on member_points (tenant_id, reversal_of) where reversal_of is not null;

alter table members enable row level security;
drop policy if exists tenant_isolation on members;
create policy tenant_isolation on members
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on members to m2office_app;

alter table member_rewards enable row level security;
drop policy if exists tenant_isolation on member_rewards;
create policy tenant_isolation on member_rewards
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on member_rewards to m2office_app;

alter table member_points enable row level security;
drop policy if exists tenant_isolation on member_points;
create policy tenant_isolation on member_points
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
-- ポイントの記録は追記のみ
grant select, insert on member_points to m2office_app;
