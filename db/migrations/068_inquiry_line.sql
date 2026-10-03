-- 問い合わせの記録の段 3: LINE 公式アカウント（仕様書 第33.6.2節・第33.19節）
-- 1. チャネルのシークレットとアクセストークンは、会社の接続の秘密の値として暗号化して預ける
alter table tenant_credentials drop constraint if exists tenant_credentials_kind_check;
alter table tenant_credentials add constraint tenant_credentials_kind_check check (kind in ('gemini', 'google_oauth', 'wordpress', 'inquiry_mailbox', 'line'));

-- 2. 受け口（Webhook の URL の鍵）。M2Office は鍵のハッシュだけを持つ。会社ごとに 1 つ
create table if not exists inquiry_line_hooks (
  tenant_id  text primary key references tenants(id) on delete cascade,
  hook_hash  text not null unique,
  created_at timestamptz not null default now()
);

-- 3. LINE の相手（友だち）。表示名と、いま続いている問い合わせ
create table if not exists inquiry_line_users (
  tenant_id     text not null references tenants(id) on delete cascade,
  line_user_id  text not null,
  display_name  text not null default '',
  inquiry_id    text references inquiries(id) on delete set null,
  following     boolean not null default true,
  last_at       timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  primary key (tenant_id, line_user_id)
);

-- 4. 受け取った LINE の出来事（同じ出来事を 2 度残さない。LINE は届かなかったと見ると送り直すため）
create table if not exists inquiry_line_events (
  tenant_id   text not null references tenants(id) on delete cascade,
  event_id    text not null,
  received_at timestamptz not null default now(),
  primary key (tenant_id, event_id)
);

-- 5. 返事の経路（メールか LINE か）
alter table inquiry_replies add column if not exists channel text not null default 'mail';
alter table inquiry_replies drop constraint if exists inquiry_replies_channel_check;
alter table inquiry_replies add constraint inquiry_replies_channel_check check (channel in ('mail', 'line'));

do $$
declare t text;
begin
  foreach t in array array['inquiry_line_hooks', 'inquiry_line_users', 'inquiry_line_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
  end loop;
end $$;
grant select, insert, update, delete on inquiry_line_hooks, inquiry_line_users, inquiry_line_events to m2office_app;

-- 受け口は、ログインの無い相手（LINE）が鍵で呼ぶ。鍵のハッシュから会社だけを返す
create or replace function m2o_inquiry_line_tenant(p_hash text)
returns text
language sql stable security definer set search_path = public as $$
  select tenant_id from inquiry_line_hooks where hook_hash = p_hash
$$;
grant execute on function m2o_inquiry_line_tenant(text) to m2office_app;
