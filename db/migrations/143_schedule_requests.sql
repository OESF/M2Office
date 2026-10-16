-- 社外の参加者を含む日程調整（仕様書 第9.5.3.1節。第 0.381.0 版。Q-52、ADR-0103）
--
-- 候補を送ってから、相手の返事を待つ間の記録。候補の時間（本人のカレンダーの仮押さえの予定の ID つき）・送ったメールのスレッド・状態を持つ。
-- 返事の見張り（ワーカー）がスレッドだけを読み、相手が候補を選んだら、招待の業務（本人の承認の後に送る）を始める。
create table if not exists schedule_requests (
  id                  text primary key,
  tenant_id           text not null references tenants(id) on delete cascade,
  requested_by        text not null,
  run_id              text,
  title               text not null,
  duration_min        integer not null default 60,
  internal_attendees  text[] not null default '{}',
  external_attendees  text[] not null default '{}',
  candidates          jsonb not null default '[]',
  thread_id           text,
  sent_at             timestamptz not null default now(),
  status              text not null default 'waiting' check (status in ('waiting', 'chosen', 'other', 'expired', 'cancelled', 'done')),
  chosen_index        integer,
  reply_note          text,
  expires_at          timestamptz not null,
  updated_at          timestamptz not null default now()
);
create index if not exists schedule_requests_waiting_idx on schedule_requests (tenant_id, status, expires_at);

alter table schedule_requests enable row level security;
drop policy if exists tenant_isolation on schedule_requests;
create policy tenant_isolation on schedule_requests using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on schedule_requests to m2office_app;
