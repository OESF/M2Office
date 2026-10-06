-- 会員とポイントの段 2（仕様書 第40.18節）。誕生日と誕生月の特典、会員への LINE の知らせ（承認の後に送る）。

alter table members add column if not exists birthday text check (birthday is null or birthday ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$');
alter table member_rewards add column if not exists birthday_only boolean not null default false;

-- 会員への LINE の知らせ。宛先は用意したときの会員の ID を持ち、送るときに 1 人ずつ文を差し込む
create table if not exists member_messages (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  kind         text not null check (kind in ('expiry', 'custom')),
  audience     text not null check (audience in ('line', 'away', 'expiring')),
  text         text not null check (char_length(text) between 1 and 500),
  recipients   text[] not null default '{}',
  status       text not null default 'draft' check (status in ('draft', 'awaiting', 'sent', 'failed', 'rejected')),
  run_id       text,
  sent         integer not null default 0,
  note         text not null default '',
  created_by   text not null,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);
create index if not exists member_messages_tenant on member_messages (tenant_id, created_at desc);

alter table member_messages enable row level security;
drop policy if exists tenant_isolation on member_messages;
create policy tenant_isolation on member_messages
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on member_messages to m2office_app;
