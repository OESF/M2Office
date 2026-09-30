-- 組織知識の種類と管理（仕様書 第11.11節、ADR-0056）
--
-- 知識を登録の経路で 3 つに分ける（rule: 管理者が登録した社内規程、minutes: 業務が登録した議事録、learned: 秘書が学んだこと）。
-- 社内規程は版を残し（knowledge_item_versions）、施行日で切り替える。社内規程と議事録は消さずに廃止し（status = retired）、1 年は戻せる。
-- 秘書が学んだこと（会社の知識と各人の記憶）は週 1 回整理し、しまったもの（status = archived）は 1 年で消す。
-- 古い版と廃止した規程の本文は 7 年残す。

alter table knowledge_items add column if not exists category text not null default 'rule'
  check (category in ('rule', 'minutes', 'learned'));
alter table knowledge_items add column if not exists status text not null default 'active'
  check (status in ('active', 'retired', 'archived'));
alter table knowledge_items add column if not exists status_at timestamptz;
-- しまった理由（merged: まとめた、stale: 新しい事実で古くなった、unused: 半年使われない、conflict: 社内規程と食い違う）
alter table knowledge_items add column if not exists status_reason text;
alter table knowledge_items add column if not exists effective_from date;
alter table knowledge_items add column if not exists last_used_at timestamptz;
alter table knowledge_items add column if not exists merged_into text;

-- これまでに登録したものを、登録の経路で分ける（第11.11.1節）
update knowledge_items set category = case
    when kind = 'promoted' then 'learned'
    when origin_run_id is not null or kind = 'minutes' then 'minutes'
    else 'rule' end
  where category = 'rule';
update knowledge_items set effective_from = (updated_at at time zone 'Asia/Tokyo')::date
  where category = 'rule' and effective_from is null;
update knowledge_items set last_used_at = updated_at where last_used_at is null;
create index if not exists knowledge_items_status_idx on knowledge_items (tenant_id, category, status);

-- 社内規程の版（第11.11.2節）。施行している版は knowledge_items にも写す。施行日が先の版はここにだけある
create table if not exists knowledge_item_versions (
  tenant_id       text not null references tenants(id) on delete cascade,
  item_id         text not null references knowledge_items(id) on delete cascade,
  version         integer not null,
  effective_from  date not null,
  title           text not null,
  body            text not null,
  source          text not null,
  compartment     text,
  saved_by        text,
  saved_at        timestamptz not null default now(),
  -- 人事・給与の設定と食い違う項目（第30.8.2節）。規程を登録・改定したときに AI が読んで作る。見終えたら dismissed にする
  hr_check        jsonb,
  hr_check_dismissed_at timestamptz,
  primary key (item_id, version)
);
create index if not exists knowledge_item_versions_tenant_idx on knowledge_item_versions (tenant_id, item_id);
alter table knowledge_item_versions enable row level security;
drop policy if exists tenant_isolation on knowledge_item_versions;
create policy tenant_isolation on knowledge_item_versions
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on knowledge_item_versions to m2office_app;

-- いまの社内規程を、最初の版として写す
insert into knowledge_item_versions (tenant_id, item_id, version, effective_from, title, body, source, compartment, saved_at)
select tenant_id, id, version, effective_from, title, body, source, compartment, updated_at
  from knowledge_items where category = 'rule'
on conflict (item_id, version) do nothing;

-- 個人の記憶の整理（第11.11.4節）
alter table memories add column if not exists status text not null default 'active'
  check (status in ('active', 'archived'));
alter table memories add column if not exists archived_at timestamptz;
alter table memories add column if not exists archive_reason text;
alter table memories add column if not exists last_used_at timestamptz;
alter table memories add column if not exists merged_into text;
update memories set last_used_at = created_at where last_used_at is null;
create index if not exists memories_status_idx on memories (tenant_id, user_id, status);
