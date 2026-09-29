-- 社内のお知らせと、朝のブリーフの人ごとの中身。仕様書 第10.15節・第9.5.5.1.1節、ADR-0047
--
-- お知らせは、部署などから社内へのお願い・連絡（年末調整の書類の締切など）。宛先の人の朝のブリーフに載せる。
-- 受け取った人ごとに、初めてブリーフに載せた日時（本文ごと載せるのは 1 回だけ）と、済んだ日時を持つ。

-- 個人設定の区分: 朝のブリーフの中身（関心の分野・外した項目）
alter table user_settings add column if not exists brief jsonb;

create table if not exists notices (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  author_id     text not null references users(id) on delete cascade,
  title         text not null,
  body          text not null default '',
  -- 申し込み先などのリンク（https だけ）。無ければ空
  link          text not null default '',
  -- 全員宛てか。false なら group_ids のどれかに入っている人に載せる
  audience_all  boolean not null default true,
  group_ids     text[] not null default '{}',
  -- 締切（無ければ null）と、載せる最後の日
  due_on        date,
  until_on      date not null,
  created_at    timestamptz not null default now(),
  withdrawn_at  timestamptz,
  withdrawn_by  text
);
create index if not exists notices_tenant_idx on notices (tenant_id, until_on) where withdrawn_at is null;

create table if not exists notice_receipts (
  tenant_id       text not null references tenants(id) on delete cascade,
  notice_id       text not null references notices(id) on delete cascade,
  user_id         text not null references users(id) on delete cascade,
  -- 初めて朝のブリーフに載せた日時（本文ごと載せたのはこの 1 回）
  first_shown_at  timestamptz,
  -- 本人が済んだと言った日時
  done_at         timestamptz,
  primary key (tenant_id, notice_id, user_id)
);

alter table notices enable row level security;
drop policy if exists tenant_isolation on notices;
create policy tenant_isolation on notices
  using (tenant_id = m2o_current_tenant())
  with check (tenant_id = m2o_current_tenant());

alter table notice_receipts enable row level security;
drop policy if exists tenant_isolation on notice_receipts;
create policy tenant_isolation on notice_receipts
  using (tenant_id = m2o_current_tenant())
  with check (tenant_id = m2o_current_tenant());

grant select, insert, update on notices, notice_receipts to m2office_app;
