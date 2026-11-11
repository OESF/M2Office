-- Google Chat の使い方（仕様書 第10.16節、ADR-0138。第 0.559.0 版）
--
-- 1. 通知しない時間帯を決めていなかった人（空で保存されていた人）に、既定の時間帯（21:00〜翌 7:00）を当てる。
--    これまでの空は「指定なし」だったが、これからの空は「時間で控えない」の意味になるため、いったん外して既定に戻す。
-- 2. 会話の記録に経路を持たせる（Chat で頼んだものは 'chat'。画面と音声は空のまま）。
-- 3. Chat アプリの受け口の鍵（ハッシュだけ）。Google が、ログインの無いまま鍵の URL を呼ぶ。鍵のハッシュから会社だけを返す関数を置く。
-- 4. 受け取った発言の ID（Google は同じ出来事を何度か届けるため、1 回だけ扱う）。7 日で消す。
-- 5. Chat で頼まれて後ろへ回した依頼の、返す先（個別メッセージか、スペースで本人にだけ見える形か）。

update user_settings set notifications = notifications - 'quietHours'
 where notifications ? 'quietHours' and notifications->'quietHours' = 'null'::jsonb;

alter table conversations add column if not exists channel text check (channel is null or channel in ('chat'));

create table if not exists chat_app_hooks (
  tenant_id  text primary key references tenants(id) on delete cascade,
  hook_hash  text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists chat_inbound_messages (
  tenant_id     text not null references tenants(id) on delete cascade,
  message_name  text not null,
  received_at   timestamptz not null default now(),
  primary key (tenant_id, message_name)
);
create index if not exists chat_inbound_messages_age_idx on chat_inbound_messages (received_at);

create table if not exists chat_pending_replies (
  tenant_id       text not null references tenants(id) on delete cascade,
  run_id          text not null,
  user_id         text not null,
  space           text not null check (space ~ '^spaces/[A-Za-z0-9_-]+$'),
  thread          text,
  private_viewer  text,
  request         text not null default '',
  approval_told   boolean not null default false,
  created_at      timestamptz not null default now(),
  primary key (tenant_id, run_id)
);

do $$
declare t text;
begin
  foreach t in array array['chat_app_hooks', 'chat_inbound_messages', 'chat_pending_replies'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
  end loop;
end $$;
grant select, insert, update, delete on chat_app_hooks, chat_inbound_messages, chat_pending_replies to m2office_app;

create or replace function m2o_chat_hook_tenant(p_hash text)
returns text
language sql stable security definer set search_path = public as $$
  select tenant_id from chat_app_hooks where hook_hash = p_hash
$$;
grant execute on function m2o_chat_hook_tenant(text) to m2office_app;

-- 返す先の残っている会社（API の見回りが、会社をまたいで ID だけを引く。中身は会社ごとに引く）
create or replace function m2o_chat_pending_tenants()
returns setof text
language sql stable security definer set search_path = public as $$
  select distinct tenant_id from chat_pending_replies
$$;
grant execute on function m2o_chat_pending_tenants() to m2office_app;
