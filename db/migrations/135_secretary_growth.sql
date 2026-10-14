-- 秘書の成長の段 1（仕様書 第11.13節。第 0.363.0 版。ADR-0095）
--
-- 覚えていることに種類（事実・仕事のやり方の好み）を持たせ、秘書が本人についてまとめた「本人の像」を本人ごとに 1 つ持つ。
-- 本人の像は本人だけのもの。記憶を直す・消すと作り直す印を付け、記憶をすべて消すと像も消す（リポジトリが行う）。
alter table memories add column if not exists kind text not null default 'fact';
alter table memories drop constraint if exists memories_kind_check;
alter table memories add constraint memories_kind_check check (kind in ('fact', 'preference'));

create table if not exists user_profiles (
  tenant_id     text not null references tenants(id) on delete cascade,
  user_id       text not null,
  body          text not null check (char_length(body) <= 4000),
  memory_count  integer not null default 0,
  stale         boolean not null default false,
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

alter table user_profiles enable row level security;
drop policy if exists tenant_isolation on user_profiles;
create policy tenant_isolation on user_profiles using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on user_profiles to m2office_app;
