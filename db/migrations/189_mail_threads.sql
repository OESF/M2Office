-- メールを M2Office の中で片付ける（仕様書 第9.5.1.1節、ADR-0131。第 0.540.0 版）
--
-- ワーカーが 15 分ごとに本人の Gmail の新しいメールを見て、スレッドごとに振り分け、片付くまで並べる。
-- 本文は持たない（開いたときに Gmail から読む）。片付いてから 7 日で消し、Google の連携の解除・データの削除の求めではすぐ消す（第14.3.2節）。
-- 見られるのは本人だけ。利用者を消せば行も消える。

-- 1 人ずつの見回りの様子（履歴の番号・最後に見た時刻・本人の頼み）
create table if not exists mail_watch (
  tenant_id   text not null references tenants(id) on delete cascade,
  user_id     text not null references users(id) on delete cascade,
  history_id  text,
  started_at  timestamptz,
  checked_at  timestamptz,
  error       text,
  -- 本人が秘書に頼んだこと（見なくていい・すぐ知らせる相手・相手ごとの返事待ちの日数）
  prefs       jsonb not null default '{}'::jsonb,
  primary key (tenant_id, user_id)
);

alter table mail_watch enable row level security;
drop policy if exists tenant_isolation on mail_watch;
create policy tenant_isolation on mail_watch using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on mail_watch to m2office_app;

-- スレッドごとの振り分けと状態
create table if not exists mail_threads (
  tenant_id        text not null references tenants(id) on delete cascade,
  user_id          text not null references users(id) on delete cascade,
  thread_id        text not null,
  -- reply（返事が要る）・action（対応が要る）・read（目を通すだけ）・promo（宣伝・お知らせ）・waiting（返事待ち）
  grp              text not null,
  -- open（並べる）・done（片付いた）
  state            text not null default 'open',
  done_reason      text,
  done_at          timestamptz,
  -- 最後のメールの ID と、返信するときに相手にするメールの ID（最後に届いたもの）
  last_message_id  text not null default '',
  reply_to_id      text not null default '',
  from_text        text not null default '',
  subject          text not null default '',
  summary          text not null default '',
  due_text         text not null default '',
  due_date         date,
  last_at          timestamptz not null,
  -- 本人が最後に送った時刻と、相手（返事待ちの日数を相手ごとに変えるため）
  sent_at          timestamptz,
  sent_to          text not null default '',
  -- 返事の宛先の案（宛先・CC）
  recipients       jsonb not null default '{"to": [], "cc": []}'::jsonb,
  -- 下書き: none・pending（作る前）・ready
  draft_state      text not null default 'none',
  draft            text not null default '',
  -- 送るときの控え（本人が確かめた宛先・CC・件名・本文）と、送る実行
  outgoing         jsonb,
  send_run_id      text,
  notified_at      timestamptz,
  updated_at       timestamptz not null default now(),
  primary key (tenant_id, user_id, thread_id)
);
create index if not exists mail_threads_open_idx on mail_threads (tenant_id, user_id, state, grp);
create index if not exists mail_threads_done_idx on mail_threads (tenant_id, done_at) where state = 'done';

alter table mail_threads enable row level security;
drop policy if exists tenant_isolation on mail_threads;
create policy tenant_isolation on mail_threads using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on mail_threads to m2office_app;

-- 業務「メールの整理・下書きの作成」と「返信待ちの追跡」は、メールの画面に置き換えた。
-- その定時実行を消し、持っていた人に一度だけ知らせる（移行のファイルは毎回すべて当て直されるため、一度だけ行う印を使う）
do $$
begin
  if exists (select 1 from m2o_data_fixes where id = 'mail-screen-replaces-agents-0.540') then return; end if;
  insert into notifications (id, tenant_id, user_id, kind, title, body, run_id, read_at, created_at)
  select gen_random_uuid()::text, s.tenant_id, s.user_id, 'run',
         'メールの画面で、いつも片付けておくようにしました',
         '「メールの整理・下書きの作成」と「返信待ちの追跡」の定時実行は、メールの画面に置き換えたので消しました。左のメニューの「業務」の「メール」を開いてください。',
         null, null, now()
    from (select distinct tenant_id, user_id from schedules where agent_id in ('inbox-triage', 'reply-followup')) s;
  delete from schedules where agent_id in ('inbox-triage', 'reply-followup');
  insert into m2o_data_fixes (id) values ('mail-screen-replaces-agents-0.540');
end $$;
