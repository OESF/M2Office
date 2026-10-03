-- 問い合わせの記録（内蔵の拡張。仕様書 第33章・第33.17節）
-- 1. 会社の設定の区分（入り切り）
alter table tenant_settings add column if not exists inquiries jsonb;

-- 2. 問い合わせ。利用範囲の中で会社で共有する。状態: open（対応中）・done（済み）・dropped（見送り）
create table if not exists inquiries (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  -- 誰から（分かるものだけ。分からない項目は空）
  from_name     text not null default '',
  from_company  text not null default '',
  from_phone    text not null default '',
  from_email    text not null default '',
  -- 名刺管理の連絡先（会社で共有のもの）。連絡先を削除しても問い合わせは残す
  contact_id    text,
  channel       text not null check (channel in ('phone', 'mail', 'form', 'line', 'visit', 'other')),
  category      text not null default '',
  summary       text not null default '',
  -- どこで知ったか。分からなければ「不明」（推し量って埋めない）
  source        text not null default '不明',
  temperature   text not null default 'normal' check (temperature in ('high', 'normal', 'low')),
  status        text not null default 'open' check (status in ('open', 'done', 'dropped')),
  received_by   text not null,
  -- 次にやることが無いまま動いていないと、残した人に一度だけ知らせた日時（第33.7節）
  idle_notified_at timestamptz,
  first_at      timestamptz not null default now(),
  last_at       timestamptz not null default now(),
  created_by    text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists inquiries_tenant_last on inquiries (tenant_id, last_at desc);
create index if not exists inquiries_tenant_contact on inquiries (tenant_id, contact_id);

-- 3. 会話の履歴。原文（秘書に話した文・書いた文）は 90 日で消す（第33.12節）
create table if not exists inquiry_events (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  inquiry_id    text not null references inquiries(id) on delete cascade,
  at            timestamptz not null default now(),
  direction     text not null check (direction in ('in', 'out')),
  channel       text not null check (channel in ('phone', 'mail', 'form', 'line', 'visit', 'other')),
  summary       text not null default '',
  body          text,
  created_by    text not null,
  created_at    timestamptz not null default now()
);
create index if not exists inquiry_events_inquiry on inquiry_events (tenant_id, inquiry_id, at);

-- 4. 次にやること。期限の前の日と、期限を過ぎたときに担当に知らせる（第33.7節）
create table if not exists inquiry_tasks (
  id                 text primary key,
  tenant_id          text not null references tenants(id) on delete cascade,
  inquiry_id         text not null references inquiries(id) on delete cascade,
  assignee           text not null,
  what               text not null,
  due                date,
  done_at            timestamptz,
  notified_before_at timestamptz,
  notified_overdue_at timestamptz,
  created_by         text not null,
  created_at         timestamptz not null default now()
);
create index if not exists inquiry_tasks_due on inquiry_tasks (tenant_id, due) where done_at is null;

do $$
declare t text;
begin
  foreach t in array array['inquiries', 'inquiry_events', 'inquiry_tasks'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
  end loop;
end $$;
grant select, insert, update, delete on inquiries, inquiry_events, inquiry_tasks to m2office_app;
