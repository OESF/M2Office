-- 名刺管理（内蔵の拡張）。仕様書 第27章・第12.13節、ADR-0042
--
-- 連絡先（1 人の人）と、名刺（受け取った 1 枚の紙。画像と読み取りの結果）を持つ。
-- 名刺は会社で共有するのを既定にし、1 枚ずつ「自分だけ」にできる（第27.7節）。
-- 自分だけのものは、テナントに加えて持ち主でも行を絞る（管理者も見られない。第27.10節）。

-- 会社の設定の区分: 名刺管理を使うか・取り込んだ名刺の既定の範囲
alter table tenant_settings add column if not exists cards jsonb;

-- 持ち主で絞るための、いまの利用者（問い合わせのトランザクションごとに設定する。未設定なら空）
create or replace function m2o_current_user() returns text
  language sql stable as $$ select nullif(current_setting('app.user_id', true), '') $$;

create table if not exists contacts (
  id               text primary key,
  tenant_id        text not null references tenants(id) on delete cascade,
  -- company（会社で共有）/ personal（自分だけ）
  scope            text not null check (scope in ('company', 'personal')),
  -- 取り込んだ人。自分だけの名刺はこの人だけが見られる
  owner_user_id    text not null,
  name             text not null default '',
  name_kana        text not null default '',
  -- ふりがなを名刺から読んだのでなく推定したか（第27.5節）
  kana_estimated   boolean not null default false,
  company          text not null default '',
  department       text not null default '',
  title            text not null default '',
  postal_code      text not null default '',
  address          text not null default '',
  -- [{ "kind": "main|direct|mobile|fax", "number": "03-..." }]
  phones           jsonb not null default '[]',
  emails           text[] not null default '{}',
  website          text not null default '',
  -- 資格・SNS など、ほかの項目
  extra            text not null default '',
  note             text not null default '',
  -- active（有効）/ trash（ごみ箱。30 日で本当に消す）
  status           text not null default 'active' check (status in ('active', 'trash')),
  trashed_at       timestamptz,
  created_by       text not null,
  created_at       timestamptz not null default now(),
  updated_by       text,
  updated_at       timestamptz not null default now()
);
create index if not exists contacts_tenant_idx on contacts (tenant_id, status, updated_at desc);
create index if not exists contacts_emails_idx on contacts using gin (emails);

create table if not exists contact_cards (
  id               text primary key,
  tenant_id        text not null references tenants(id) on delete cascade,
  -- 読み取るまでと、読み取れなかったものは連絡先が無い
  contact_id       text references contacts(id) on delete cascade,
  -- 取り込むときに選んだ範囲。連絡先ができたら連絡先の範囲に合わせる
  scope            text not null check (scope in ('company', 'personal')),
  -- 受け取った（取り込んだ）人
  owner_user_id    text not null,
  -- 一度に渡した名刺のまとまり（進み具合と終わりの知らせに使う）
  batch_id         text not null,
  -- まとまりの中の順番（ファイルの表と裏を見分けるのに使う）
  seq              integer not null default 0,
  front_file_id    text references files(id) on delete set null,
  back_file_id     text references files(id) on delete set null,
  -- 画像を正しい向きに回す角度（0・90・180・270。読み取りのときに見分ける）
  front_rotation   integer not null default 0,
  back_rotation    integer not null default 0,
  -- 撮るときに「裏も撮る」で表と裏を組にしたか（読み取りで表裏をまとめ直さない）
  paired           boolean not null default false,
  -- pending（待ち）/ reading（読み取り中）/ done（登録済み）/ failed（読み取れなかった）
  status           text not null default 'pending' check (status in ('pending', 'reading', 'done', 'failed')),
  failure_reason   text,
  -- 読み取ったままの結果と、人が直した項目（直した値を正とし、読み取り直しで上書きしない）
  extracted        jsonb,
  corrected        jsonb not null default '{}',
  -- アプリが取り込んだ人のタイムゾーンで決めて入れる。既定は日本時間（データベースの時計は世界標準時のため）
  received_on      date not null default (now() at time zone 'Asia/Tokyo')::date,
  attempts         integer not null default 0,
  locked_until     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists contact_cards_contact_idx on contact_cards (tenant_id, contact_id, received_on desc);
create index if not exists contact_cards_pending_idx on contact_cards (created_at) where status in ('pending', 'reading');
create index if not exists contact_cards_batch_idx on contact_cards (tenant_id, batch_id, seq);

-- テナントで絞り、自分だけのものはさらに持ち主で絞る（不変則 I-2、第27.10節）
alter table contacts enable row level security;
drop policy if exists tenant_isolation on contacts;
create policy tenant_isolation on contacts
  using (tenant_id = m2o_current_tenant() and (scope = 'company' or owner_user_id = m2o_current_user()))
  with check (tenant_id = m2o_current_tenant() and (scope = 'company' or owner_user_id = m2o_current_user()));

alter table contact_cards enable row level security;
drop policy if exists tenant_isolation on contact_cards;
create policy tenant_isolation on contact_cards
  using (tenant_id = m2o_current_tenant() and (scope = 'company' or owner_user_id = m2o_current_user()))
  with check (tenant_id = m2o_current_tenant() and (scope = 'company' or owner_user_id = m2o_current_user()));

grant select, insert, update, delete on contacts, contact_cards to m2office_app;

-- 次に読み取る名刺を 1 枚確保する。会社をまたいで見るのはこの関数だけ（第20.5節）
create or replace function m2o_claim_contact_card() returns table (id text, tenant_id text, owner_user_id text)
  language sql security definer set search_path = public as $$
  update contact_cards c
     set status = 'reading', attempts = c.attempts + 1, locked_until = now() + interval '3 minutes', updated_at = now()
   where c.id = (
     select x.id from contact_cards x
      where (x.status = 'pending' or (x.status = 'reading' and x.locked_until < now()))
        and x.attempts < 3
      order by x.created_at, x.seq
      limit 1
      for update skip locked
   )
  returning c.id, c.tenant_id, c.owner_user_id
$$;
revoke all on function m2o_claim_contact_card() from public;
grant execute on function m2o_claim_contact_card() to m2office_app;

-- 期限を過ぎたものを探す: ごみ箱に 30 日置いた連絡先と、読み取れなかった名刺（画像は撮り直しの目安として 4 週）。
-- 自分だけのものも含めて見るため、この関数だけが会社と持ち主をまたぐ（第27.7節・第27.5節）
create or replace function m2o_expired_contact_cards() returns table (
  tenant_id text, card_id text, contact_id text, front_file_id text, back_file_id text
)
  language sql security definer set search_path = public as $$
  select c.tenant_id, c.id, c.contact_id, c.front_file_id, c.back_file_id
    from contact_cards c
    left join contacts k on k.id = c.contact_id
   where (k.status = 'trash' and k.trashed_at < now() - interval '30 days')
      or (c.status = 'failed' and c.updated_at < now() - interval '28 days')
$$;
revoke all on function m2o_expired_contact_cards() from public;
grant execute on function m2o_expired_contact_cards() to m2office_app;

-- 期限を過ぎたものを本当に消す（名刺の相手からの消去の求めに応えるため。第27.7節）。画像のファイルの行も消す
create or replace function m2o_purge_contact_cards(card_ids text[]) returns integer
  language plpgsql security definer set search_path = public as $$
declare
  n integer;
  files_to_drop text[];
  contacts_to_drop text[];
begin
  select coalesce(array_agg(f), '{}') into files_to_drop
    from (select front_file_id as f from contact_cards where id = any(card_ids) and front_file_id is not null
          union select back_file_id from contact_cards where id = any(card_ids) and back_file_id is not null) s;
  select coalesce(array_agg(distinct contact_id), '{}') into contacts_to_drop
    from contact_cards where id = any(card_ids) and contact_id is not null;
  delete from contact_cards where id = any(card_ids);
  get diagnostics n = row_count;
  -- 名刺が残っていない、ごみ箱の連絡先を消す
  delete from contacts k where k.id = any(contacts_to_drop) and k.status = 'trash'
     and not exists (select 1 from contact_cards c where c.contact_id = k.id);
  delete from files where id = any(files_to_drop);
  return n;
end $$;
revoke all on function m2o_purge_contact_cards(text[]) from public;
grant execute on function m2o_purge_contact_cards(text[]) to m2office_app;
