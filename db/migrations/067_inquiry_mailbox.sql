-- 問い合わせの記録の段 2: 窓口のアカウント・返事・月の振り返り（仕様書 第33.6節・第33.9節・第33.18節）
-- 1. 窓口のアカウントのリフレッシュ トークンは、会社の接続の秘密の値として暗号化して預ける（アドレスは meta）
alter table tenant_credentials drop constraint if exists tenant_credentials_kind_check;
-- 移行は毎回はじめから流し直すため、後の移行で増えた種類の行があっても止まらないよう、ここでは今ある行を確かめない（not valid）。
-- 種類の一覧の正は最後の移行（071 以降）が確かめつきで張り直す
alter table tenant_credentials add constraint tenant_credentials_kind_check check (kind in ('gemini', 'google_oauth', 'wordpress', 'inquiry_mailbox')) not valid;

-- 2. 会話の履歴のうちメールのもの。本文は写さず、元のメールの参照と、どの宛先（別名）に届いたかだけを持つ
alter table inquiry_events add column if not exists mail_message_id text;
alter table inquiry_events add column if not exists mail_thread_id text;
alter table inquiry_events add column if not exists mail_to text;
create index if not exists inquiry_events_thread on inquiry_events (tenant_id, mail_thread_id) where mail_thread_id is not null;

-- 3. 窓口のアカウントで見たメール（同じメールを 2 度読まない。問い合わせでないと見分けたものを一覧にし、戻せるようにする）
create table if not exists inquiry_mail_messages (
  tenant_id     text not null references tenants(id) on delete cascade,
  message_id    text not null,
  thread_id     text not null,
  direction     text not null check (direction in ('in', 'out')),
  -- inquiry（問い合わせにした・続きに足した）・skipped（問い合わせでない）
  status        text not null check (status in ('inquiry', 'skipped')),
  inquiry_id    text references inquiries(id) on delete set null,
  from_text     text not null default '',
  subject       text not null default '',
  mail_to       text not null default '',
  reason        text not null default '',
  received_at   timestamptz not null,
  created_at    timestamptz not null default now(),
  primary key (tenant_id, message_id)
);
create index if not exists inquiry_mail_skipped on inquiry_mail_messages (tenant_id, received_at desc) where status = 'skipped';
create index if not exists inquiry_mail_thread on inquiry_mail_messages (tenant_id, thread_id);

-- 4. 窓口のアカウントをどこまで読んだか
create table if not exists inquiry_mail_cursors (
  tenant_id     text primary key references tenants(id) on delete cascade,
  checked_until timestamptz not null
);

-- 5. 返事。下書き（draft）→ 承認待ち（awaiting）→ 送った（sent）。承認した中身の指紋が違えば送らない
create table if not exists inquiry_replies (
  id               text primary key,
  tenant_id        text not null references tenants(id) on delete cascade,
  inquiry_id       text not null references inquiries(id) on delete cascade,
  to_address       text not null,
  from_address     text not null,
  subject          text not null,
  body             text not null,
  -- 返す元のメール（スレッドに置くため）
  reply_to_message text,
  thread_id        text,
  status           text not null default 'draft' check (status in ('draft', 'awaiting', 'sent')),
  run_id           text,
  sent_message_id  text,
  created_by       text not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  sent_at          timestamptz
);
create index if not exists inquiry_replies_inquiry on inquiry_replies (tenant_id, inquiry_id, created_at desc);

-- 6. 月の振り返り（同じ月を 2 度知らせない）
create table if not exists inquiry_reviews (
  tenant_id   text not null references tenants(id) on delete cascade,
  month       text not null,
  stats       jsonb not null,
  notified_at timestamptz not null default now(),
  primary key (tenant_id, month)
);

do $$
declare t text;
begin
  foreach t in array array['inquiry_mail_messages', 'inquiry_mail_cursors', 'inquiry_replies', 'inquiry_reviews'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
  end loop;
end $$;
grant select, insert, update, delete on inquiry_mail_messages, inquiry_mail_cursors, inquiry_replies, inquiry_reviews to m2office_app;
