-- ナレッジの整理（仕様書 第44章）の段 6。メールのやり取りを資料にする（第44.18節。第 0.582.0 版。ADR-0146）。
-- 1 つのやり取り（Gmail のスレッド）を 1 つの資料（library_items の format = 'mail'）にし、AI が載せるかを決めて要約する。
-- メールの本文は持たない（Q-310）。ここには、どのスレッドを見たか・どう決めたかと、過去の分の進み具合だけを持つ。
--
-- 巻き戻し: 前の版に戻しても動く（足した表は読まれない。format = 'mail' の資料は、前の版では形式「ファイル」として一覧に出る）。消すなら
--   delete from library_items where format = 'mail'; drop table library_mail_threads; drop table library_thread_watch;

-- 見たスレッドと決めたこと（持ち主ごと）。最後に読んだメールが変わったときだけ読み直す
create table if not exists library_mail_threads (
  tenant_id        text not null references tenants(id) on delete cascade,
  owner_id         text not null,
  thread_id        text not null,
  -- kept（資料にした）・skipped（決まりか AI の判断で載せない）・failed（AI の答えを読めなかった）
  decision         text not null check (decision in ('kept', 'skipped', 'failed')),
  -- 載せない理由（bulk・invite・auto・sent_only・sensitive・ai・tombstone など。中身は持たない）
  reason           text not null default '',
  item_id          text,
  last_message_id  text not null default '',
  message_count    integer not null default 0,
  first_at         timestamptz,
  last_at          timestamptz,
  -- やり取りした相手（名前とアドレス。5 人まで）
  people           jsonb not null default '[]'::jsonb,
  checked_at       timestamptz not null default now(),
  primary key (tenant_id, owner_id, thread_id)
);
create index if not exists library_mail_threads_item on library_mail_threads (tenant_id, item_id) where item_id is not null;

-- やり取りの取り込みの進み具合（持ち主ごと）。入り切りは library_mail_watch の enabled を使う（Q-359）
create table if not exists library_thread_watch (
  tenant_id    text not null references tenants(id) on delete cascade,
  owner_id     text not null,
  -- 新しいやり取りを最後に見た時刻（15 分ごと）
  checked_at   timestamptz,
  -- 過去のやり取りを見る範囲（新しい順に、終わりから初めへ進める）
  back_from    timestamptz,
  back_until   timestamptz,
  back_token   text,
  back_done    boolean not null default false,
  -- 過去の分の件数が多く、本人が費用の目安を確かめるのを待っている（第44.18.5節）
  back_waiting boolean not null default false,
  back_day     date,
  back_count   integer not null default 0,
  scanned      integer not null default 0,
  kept         integer not null default 0,
  -- 前から添付を集めていた人に、やり取りも集め始めたことを知らせたか（Q-359）
  noticed      boolean not null default false,
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, owner_id)
);

do $$
declare t text;
begin
  foreach t in array array['library_mail_threads', 'library_thread_watch'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
    execute format('grant select, insert, update, delete on %I to m2office_app', t);
  end loop;
end $$;
