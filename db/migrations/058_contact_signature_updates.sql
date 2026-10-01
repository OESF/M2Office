-- メールの署名から異動を見つけて名刺を新しくする（仕様書 第27.6.1節、ADR-0057、Q-152）
--
-- 名刺を交換した相手から届いたメールの署名を名刺と比べ、変わった項目だけを連絡先に反映する。
-- 変えた項目の前と後を「変更の記録」に残し、「戻す」で戻せるようにする。メールの件名・本文・署名の全文は持たない。
-- どのメールかを示す ID は 7 日で消す（第14.3.2節）。

-- 変更の記録。見られる範囲は連絡先と同じ（範囲と持ち主を写して行を絞る。連絡先の範囲を変えたら合わせる）
create table if not exists contact_changes (
  id               text primary key,
  tenant_id        text not null references tenants(id) on delete cascade,
  contact_id       text not null references contacts(id) on delete cascade,
  scope            text not null check (scope in ('company', 'personal')),
  owner_user_id    text not null,
  -- 出どころ。いまは mail_signature（メールの署名）だけ
  source           text not null default 'mail_signature' check (source in ('mail_signature')),
  -- 変えた項目ごとの前と後 { "title": { "before": "課長", "after": "部長" }, "phones": { "before": [...], "after": [...] } }
  fields           jsonb not null,
  -- メールの日時（新しさの比べに使い、画面に日付を出す）
  occurred_at      timestamptz not null,
  -- メールを受け取った人（画面には出さない。削除の求めで、その人のメールから変えた値を戻すため）
  mailbox_user_id  text not null,
  -- どのメールか（Gmail のメッセージ ID）。7 日で消す
  message_id       text,
  reverted_at      timestamptz,
  reverted_by      text,
  created_at       timestamptz not null default now()
);
create index if not exists contact_changes_contact_idx on contact_changes (tenant_id, contact_id, occurred_at desc);
create index if not exists contact_changes_recent_idx on contact_changes (tenant_id, created_at desc);
create index if not exists contact_changes_mailbox_idx on contact_changes (tenant_id, mailbox_user_id);

alter table contact_changes enable row level security;
drop policy if exists tenant_isolation on contact_changes;
create policy tenant_isolation on contact_changes
  using (tenant_id = m2o_current_tenant() and (scope = 'company' or owner_user_id = m2o_current_user()))
  with check (tenant_id = m2o_current_tenant() and (scope = 'company' or owner_user_id = m2o_current_user()));
grant select, insert, update, delete on contact_changes to m2office_app;

-- 連絡先ごとの署名の見張りの状態: 最後に推論を呼んだ日時（7 日に 1 度まで）、最後に見た署名の値（戻した値を再び変えないため）、
-- 最後に署名から変えた日時（それより後に人が直したかを見分けるため）
alter table contacts add column if not exists signature_state jsonb;

-- 人ごとの見回りの位置（前回どこまでメールを見たか）
create table if not exists mail_signature_cursors (
  tenant_id        text not null references tenants(id) on delete cascade,
  user_id          text not null,
  checked_until    timestamptz not null,
  updated_at       timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
alter table mail_signature_cursors enable row level security;
drop policy if exists tenant_isolation on mail_signature_cursors;
create policy tenant_isolation on mail_signature_cursors
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on mail_signature_cursors to m2office_app;

-- 7 日を過ぎた変更の記録から、どのメールかを示す ID を消す（第14.3.2節）。会社と持ち主をまたぐのはこの関数だけ
create or replace function m2o_forget_contact_change_messages() returns integer
  language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  update contact_changes set message_id = null
   where message_id is not null and created_at < now() - interval '7 days';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function m2o_forget_contact_change_messages() from public;
grant execute on function m2o_forget_contact_change_messages() to m2office_app;
