-- 名刺の相手へのまとめてのメール（仕様書 第27.9.1節、ADR-0058、Q-95）
--
-- 1 つの文面に宛名だけを差し込み、本人が 1 回承認すると、本人の Gmail から 1 人に 1 通ずつ送る。
-- 下書きと記録は作った本人だけが見られる（テナントに加えて持ち主で行を絞る）。
-- 配信の停止は会社ごとのメールアドレスで持ち、名刺を削除しても消さない（停止を守り続けるため）。

create table if not exists bulk_mails (
  id               text primary key,
  tenant_id        text not null references tenants(id) on delete cascade,
  owner_user_id    text not null,
  subject          text not null default '',
  body             text not null default '',
  -- 宣伝を含むか（推論が本文から決める。決めていなければ null）と、決めたときの文面の要約（文面が変われば決め直す）
  advertising      boolean,
  judged_digest    text,
  -- draft（下書き）/ awaiting（承認待ち）/ sending（送っている）/ done（送り終えた）/ cancelled（取りやめた）
  status           text not null default 'draft' check (status in ('draft', 'awaiting', 'sending', 'done', 'cancelled')),
  run_id           text,
  -- 承認した宛先と文面の要約（承認の後に下書きが変わっていれば送らない）
  approved_digest  text,
  approved_at      timestamptz,
  -- 次の 1 通を送ってよい時刻（間を空けて送る）
  next_send_at     timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists bulk_mails_owner_idx on bulk_mails (tenant_id, owner_user_id, created_at desc);
create index if not exists bulk_mails_sending_idx on bulk_mails (next_send_at) where status = 'sending';

create table if not exists bulk_mail_recipients (
  id               text primary key,
  tenant_id        text not null references tenants(id) on delete cascade,
  bulk_mail_id     text not null references bulk_mails(id) on delete cascade,
  owner_user_id    text not null,
  -- 名刺を削除しても送った記録は残す（宛先のアドレスと名前は写して持つ）
  contact_id       text references contacts(id) on delete set null,
  seq              integer not null default 0,
  email            text not null default '',
  name             text not null default '',
  company          text not null default '',
  -- selected（選んだ）/ pending（送る待ち）/ sending（送っている）/ sent（送った）/ failed（送れなかった）/ skipped（送る時に除いた）
  status           text not null default 'selected' check (status in ('selected', 'pending', 'sending', 'sent', 'failed', 'skipped')),
  reason           text,
  sent_at          timestamptz
);
create index if not exists bulk_mail_recipients_mail_idx on bulk_mail_recipients (bulk_mail_id, seq);
create index if not exists bulk_mail_recipients_contact_idx on bulk_mail_recipients (tenant_id, contact_id);
create index if not exists bulk_mail_recipients_sent_idx on bulk_mail_recipients (tenant_id, owner_user_id, sent_at) where status = 'sent';

-- 作った本人だけが見られる
alter table bulk_mails enable row level security;
drop policy if exists tenant_isolation on bulk_mails;
create policy tenant_isolation on bulk_mails
  using (tenant_id = m2o_current_tenant() and owner_user_id = m2o_current_user())
  with check (tenant_id = m2o_current_tenant() and owner_user_id = m2o_current_user());
alter table bulk_mail_recipients enable row level security;
drop policy if exists tenant_isolation on bulk_mail_recipients;
create policy tenant_isolation on bulk_mail_recipients
  using (tenant_id = m2o_current_tenant() and owner_user_id = m2o_current_user())
  with check (tenant_id = m2o_current_tenant() and owner_user_id = m2o_current_user());
grant select, insert, update, delete on bulk_mails, bulk_mail_recipients to m2office_app;

-- 配信の停止（会社ごとのメールアドレス。小文字）。会社の全員のまとめてのメールから外すため、テナントだけで絞る
create table if not exists mail_opt_outs (
  tenant_id        text not null references tenants(id) on delete cascade,
  email            text not null,
  -- url（停止の URL）/ reply（返信の「配信停止」）
  source           text not null check (source in ('url', 'reply')),
  created_at       timestamptz not null default now(),
  primary key (tenant_id, email)
);
alter table mail_opt_outs enable row level security;
drop policy if exists tenant_isolation on mail_opt_outs;
create policy tenant_isolation on mail_opt_outs
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on mail_opt_outs to m2office_app;

-- 次に送る 1 通を確保する。会社と持ち主をまたいで見るのはこの関数だけ（第20.5節）。
-- 送っているまとめてのメールのうち、送ってよい時刻を過ぎ、送る待ちの宛先が残っているものから 1 つを返し、次の時刻を先へ送る。
-- 送り終えたかの判断と知らせはアプリが行う
create or replace function m2o_claim_bulk_recipient(gap_seconds integer) returns table (
  tenant_id text, owner_user_id text, bulk_mail_id text, recipient_id text
)
  language plpgsql security definer set search_path = public as $$
declare
  m bulk_mails%rowtype;
  rid text;
begin
  select * into m from bulk_mails b
   where b.status = 'sending' and (b.next_send_at is null or b.next_send_at <= now())
     and exists (select 1 from bulk_mail_recipients x where x.bulk_mail_id = b.id and x.status = 'pending')
   order by b.next_send_at nulls first
   limit 1
   for update skip locked;
  if not found then return; end if;
  select x.id into rid from bulk_mail_recipients x where x.bulk_mail_id = m.id and x.status = 'pending' order by x.seq limit 1;
  update bulk_mails set next_send_at = now() + make_interval(secs => gap_seconds), updated_at = now() where id = m.id;
  update bulk_mail_recipients set status = 'sending' where id = rid;
  tenant_id := m.tenant_id; owner_user_id := m.owner_user_id; bulk_mail_id := m.id; recipient_id := rid;
  return next;
end $$;
revoke all on function m2o_claim_bulk_recipient(integer) from public;
grant execute on function m2o_claim_bulk_recipient(integer) to m2office_app;
