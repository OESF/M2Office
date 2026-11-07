-- 資料（仕様書 第44章）の段 2。メールの添付の取り込み（第44.4節）。
-- 本人が「資料」の画面で 1 度オンにすると、受け取ったメールの添付を自動で資料に集める。全社で一律にオンにはしない。
-- メールの本文は持たない（Q-310）。入口の記録に、送り主・件名・メールの ID（Gmail の ID）だけを持つ（第44.9節）。
--
-- 巻き戻し: 前の版に戻しても動く（足した表と索引は読まれない）。消すなら
--   drop table library_mail_watch; drop index library_item_origins_message; drop index library_item_origins_message_find;

-- 持ち主ごとのオンとオフと、どこまで見たか（第44.14節）
create table if not exists library_mail_watch (
  tenant_id    text not null references tenants(id) on delete cascade,
  owner_id     text not null,
  enabled      boolean not null default false,
  -- 新しいメールを最後に見た時刻（15 分ごと）
  checked_at   timestamptz,
  -- 過去のメールを見る範囲。新しい順に、終わりから初めへ進める
  back_from    timestamptz,
  back_until   timestamptz,
  back_token   text,
  back_done    boolean not null default false,
  -- 過去のメールを見た日（日本時間）と、その日に見た通数（1 人 1 日 500 通まで）
  back_day     date,
  back_count   integer not null default 0,
  scanned      integer not null default 0,
  imported     integer not null default 0,
  -- 最後に Gmail を読めなかった理由（読めていれば空）
  error        text not null default '',
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, owner_id)
);
create index if not exists library_mail_watch_on on library_mail_watch (tenant_id) where enabled;

-- 同じメールの入口を 2 度記録しない。一度見たメールを読み直さないためにも使う
create unique index if not exists library_item_origins_message on library_item_origins (tenant_id, item_id, message_id) where message_id is not null;
create index if not exists library_item_origins_message_find on library_item_origins (tenant_id, message_id) where message_id is not null;

alter table library_mail_watch enable row level security;
drop policy if exists tenant_isolation on library_mail_watch;
create policy tenant_isolation on library_mail_watch using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on library_mail_watch to m2office_app;
