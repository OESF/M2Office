-- 外部のアプリからの配信の依頼（仕様書 第13.4.4節、Q-254）。外部のアプリ（最初は M2Medical の声掛け）が渡した文を、
-- 承認のあと会社の窓口のアカウントから 1 人に 1 通ずつ送る。結果と配信の停止は、アプリが取りに来る（M2Office からは送らない）。
--
-- 宛先（名前・アドレス）は暗号化して contact_enc に持ち（アプリの鍵 M2OFFICE_SECRET_KEY）、その人に送り終えたら消す（null）。
-- 送れなかった知らせと停止の返信を照らすため、アドレスの SHA-256（email_hash）だけを hash_until（送ってから 3 日）まで持つ。
-- 結果（宛先の ID・状態・時刻）は送り終えてから 30 日で行ごと消す。結果と停止の印は通し番号（result_seq・seq）。
-- 宛先の ID が読めなかった停止だけ、差出人のアドレスを暗号化して email_enc に持ち、30 日で消す。
-- 巻き戻し: 表と通し番号を消す（ほかの表から参照されない）。

create sequence if not exists delivery_result_seq;
create sequence if not exists delivery_stop_seq;

create table if not exists deliveries (
  id                  text primary key,
  tenant_id           text not null references tenants(id) on delete cascade,
  app_id              text not null,
  request_id          text not null,
  title               text not null,
  channel             text not null check (channel in ('mail', 'line')),
  status              text not null check (status in ('awaiting_approval', 'scheduled', 'sending', 'done', 'rejected')),
  send_at             timestamptz,
  subject             text not null,
  html                text not null,
  body_text           text not null,
  "values"            jsonb not null default '{}',
  logo                jsonb,
  run_id              text,
  total               integer not null,
  -- テスト送信（test: true）。結果を持たない
  test                boolean not null default false,
  created_at          timestamptz not null default now(),
  finished_at         timestamptz,
  -- 結果を消す時刻（送り終えてから 30 日）。消したら purged
  purge_after         timestamptz,
  purged              boolean not null default false,
  unique (tenant_id, app_id, request_id)
);
create index if not exists deliveries_open on deliveries (tenant_id, status) where status in ('awaiting_approval', 'scheduled', 'sending');

create table if not exists delivery_recipients (
  tenant_id     text not null references tenants(id) on delete cascade,
  delivery_id   text not null references deliveries(id) on delete cascade,
  recipient_id  text not null,
  -- 送り終えたら null
  contact_enc   text,
  email_hash    text,
  hash_until    timestamptz,
  status        text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'stopped')),
  reason        text,
  stop_channel  text,
  at            timestamptz,
  next_send_at  timestamptz,
  -- 結果が変わるたびに付け直す通し番号（アプリが取りに来る印）
  result_seq    bigint,
  primary key (tenant_id, delivery_id, recipient_id)
);
create index if not exists delivery_recipients_hash on delivery_recipients (tenant_id, email_hash) where email_hash is not null;
create index if not exists delivery_recipients_rid on delivery_recipients (tenant_id, recipient_id);

-- 配信の停止（アプリが取りに来る）。source は見つけたメールと宛先（同じ返信を 2 度入れない）
create table if not exists delivery_stops (
  tenant_id     text not null references tenants(id) on delete cascade,
  seq           bigint not null default nextval('delivery_stop_seq'),
  app_id        text not null,
  delivery_id   text,
  recipient_id  text,
  email_enc     text,
  channel       text not null default 'mail',
  at            timestamptz not null,
  source        text not null,
  created_at    timestamptz not null default now(),
  primary key (tenant_id, seq),
  unique (tenant_id, app_id, source)
);
create index if not exists delivery_stops_app on delivery_stops (tenant_id, app_id, seq);

-- 窓口のアカウントの受信を、配信の停止と送れなかった知らせのために読んだ位置（会社ごと）
create table if not exists delivery_state (
  tenant_id   text primary key references tenants(id) on delete cascade,
  mail_cursor timestamptz
);

-- 第 0.425.0 版の形（結果を返す先へ送る形。配備していない）で作った開発の置き場を、取りに来る形にそろえる
alter table deliveries drop column if exists callback_url;
alter table deliveries drop column if exists callback_secret_enc;
alter table deliveries drop column if exists callback_next_at;
alter table deliveries drop column if exists callback_attempts;
alter table deliveries drop column if exists callback_failing_since;
alter table deliveries drop column if exists callback_failed;
alter table deliveries drop column if exists done_reported;
alter table deliveries add column if not exists test boolean not null default false;
alter table delivery_recipients alter column contact_enc drop not null;
alter table delivery_recipients drop column if exists reported;
alter table delivery_recipients add column if not exists hash_until timestamptz;
alter table delivery_recipients add column if not exists result_seq bigint;
alter table ext_apps drop column if exists callback_key_enc;
create index if not exists delivery_recipients_results on delivery_recipients (tenant_id, delivery_id, result_seq) where result_seq is not null;

do $$ declare t text; begin
  foreach t in array array['deliveries', 'delivery_recipients', 'delivery_stops', 'delivery_state'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
  end loop; end $$;

grant select, insert, update, delete on deliveries, delivery_recipients, delivery_stops, delivery_state to m2office_app;
grant usage, select on sequence delivery_result_seq, delivery_stop_seq to m2office_app;
