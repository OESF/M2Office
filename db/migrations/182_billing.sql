-- クラウド版の料金と申し込み（仕様書 第23.3.1節・第23.4.5節、ADR-0123・ADR-0124。第 0.525.0 版）
--
-- 請求の正は M2Office が持つ。運営の領域（ops スキーマ）に、請求の相手・月の人数の最大・請求を置く。
-- ロールごとに決めた関数だけを使う。
--   m2office_app    … 会社の管理者の画面とワーカー（m2o_billing_*）
--   m2office_ops    … マスター管理画面（ops.billing_*）
--   m2office_signup … 申し込みの口（ops.signup_*）。業務の表も運営の表も直接は読めない
-- 請求の相手の行が無い会社は「請求しない」として扱う（運営者が作った会社・体験版・ローカルの形）。
-- 最初の 1 人はずっと無料。単価は月間と年間の 2 つ。クラスの上限と定額の契約もここで持つ。
--
-- ロールは NOLOGIN で作る。ログインと合言葉は scripts/migrate.mjs が SIGNUP_DATABASE_URL から付ける。
--
-- 巻き戻し: 前の版に戻しても動く（足した表と列は読まれない）。ただし利用者の表の仕掛けは残るので、消すなら
--   drop trigger billing_seats on users; drop trigger billing_starter_guard on users; drop trigger billing_first_login on sessions;
--   のあとで、ops.billing_* の表と m2o_billing_*・ops.billing_*・ops.signup_* の関数を消し、users.first_login_at の列を消す。

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'm2office_signup') then
    create role m2office_signup nologin nosuperuser nobypassrls;
  end if;
end $$;
grant usage on schema ops to m2office_signup;

-- ---- 数える人（招待中は数えない。第23.4.5節「人数の数え方」） ----

-- 招待した人は status = 'active' で作られるので、初めてログインした時刻で「招待中」と分ける
alter table users add column if not exists first_login_at timestamptz;
update users u set first_login_at = s.first_at
  from (select tenant_id, user_id, min(created_at) as first_at from sessions group by tenant_id, user_id) s
 where u.first_login_at is null and u.tenant_id = s.tenant_id and u.id = s.user_id;

create or replace function m2o_billing_first_login() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  update users set first_login_at = now() where tenant_id = new.tenant_id and id = new.user_id and first_login_at is null;
  return new;
end $$;
drop trigger if exists billing_first_login on sessions;
create trigger billing_first_login after insert on sessions for each row execute function m2o_billing_first_login();

-- ---- 表 ----

-- 料金の設定（配備ごとに 1 つ）。受付は既定で閉じる（第23.3.1節「受け付けるかどうか」）
create table if not exists ops.billing_settings (
  id               integer primary key default 1 check (id = 1),
  signup_open      boolean not null default false,
  monthly_price_jpy integer not null default 1800 check (monthly_price_jpy >= 0),
  annual_price_jpy  integer not null default 1500 check (annual_price_jpy >= 0),
  tax_percent      integer not null default 10 check (tax_percent between 0 and 100),
  registration_no  text not null default '',
  bank_account     text not null default '',
  terms_version    text not null default '',
  updated_by       text not null default '',
  updated_at       timestamptz not null default now()
);
insert into ops.billing_settings (id) values (1) on conflict (id) do nothing;

-- 請求の相手。行が無い会社は請求しない
create table if not exists ops.billing_accounts (
  tenant_id            text primary key,
  category             text not null check (category in ('starter', 'card', 'transfer', 'none')),
  billing_name         text not null default '',
  customer_id          text,
  -- 請求を始める月（YYYY-MM）。これより前の月は請求しない
  billed_from          text,
  -- クラス。スターターは category = 'starter' で表す
  billing_class        text not null default 'small_business' check (billing_class in ('small_business', 'business', 'enterprise')),
  -- 契約の形。null は未選択（月間として扱う）
  contract_term        text check (contract_term in ('monthly', 'annual')),
  -- 年間契約の期間（契約した日から 12 か月。1 人の間は null で、期間が始まらない）
  term_start           date,
  term_end             date,
  -- 年間契約の席（同時に使った有料の人数の最大）と、期間の始めに写した単価
  paid_seats           integer not null default 0,
  annual_unit_jpy      integer,
  -- 月間から年間へ移る日（翌月 1 日）。更新のときに月間へ移るか
  annual_start_on      date,
  next_term            text check (next_term = 'monthly'),
  -- 月間の請求を作る最後の月（YYYY-MM）。年間へ移ると置く
  monthly_until        text,
  -- ビジネスとエンタープライズの上限と年額（運営者が契約ごとに入れる。上限の null は上限なし）
  seat_limit           integer check (seat_limit > 0),
  fixed_annual_jpy     integer check (fixed_annual_jpy > 0),
  -- 更新の知らせを出した期間
  renewal_notice_for   date,
  -- この日まで使えて、過ぎると解約済みになる
  cancel_on            date,
  cancelled_at         timestamptz,
  terms_version        text,
  terms_accepted_at    timestamptz,
  terms_accepted_by    text,
  idle_notice_at       timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- 月の人数の最大（数だけ。人の名前は持たない）
create table if not exists ops.billing_seat_peaks (
  tenant_id  text not null,
  month      text not null,
  peak       integer not null,
  primary key (tenant_id, month)
);

create sequence if not exists ops.billing_invoice_seq;

create table if not exists ops.billing_invoices (
  id               text primary key,
  number           text not null unique,
  tenant_id        text not null,
  -- 月間は対象の月、それ以外は発行の月（YYYY-MM）
  month            text not null,
  -- monthly（月間）・annual（年間の 12 か月）・annual_add（増えた席）・fixed（定額の年額）
  kind             text not null default 'monthly' check (kind in ('monthly', 'annual', 'annual_add', 'fixed')),
  -- 有料の人数（定額は上限）
  seats            integer not null,
  months           integer not null default 1,
  term_start       date,
  term_end         date,
  unit_price_jpy   integer not null,
  subtotal_jpy     integer not null,
  tax_percent      integer not null,
  tax_jpy          integer not null,
  total_jpy        integer not null,
  method           text not null check (method in ('card', 'transfer')),
  -- open（未入金）・paid（入金済み）・void（取り消し）
  status           text not null default 'open' check (status in ('open', 'paid', 'void')),
  -- カードの課金の様子。pending（これから）・failed（失敗）・done（済み）。振込は null
  charge_state     text check (charge_state in ('pending', 'failed', 'done')),
  charge_error     text,
  due_date         date not null,
  issued_at        timestamptz not null default now(),
  paid_at          timestamptz,
  paid_by          text,
  provider_payment text,
  dunning_stage    integer not null default 0,
  -- 発行した時点の発行者と宛名（後で設定が変わっても請求書は変えない）
  issuer           jsonb not null,
  recipient        jsonb not null
);
create index if not exists ops_billing_invoices_open on ops.billing_invoices (status, due_date) where status = 'open';

-- 年間契約の途中で増えた席（翌月 1 日に請求する）
create table if not exists ops.billing_seat_adds (
  id              bigserial primary key,
  tenant_id       text not null,
  added_on        date not null,
  seats           integer not null,
  unit_price_jpy  integer not null,
  months          integer not null,
  term_start      date not null,
  term_end        date not null,
  invoice_id      text
);
create index if not exists ops_billing_seat_adds_open on ops.billing_seat_adds (tenant_id) where invoice_id is null;

-- 支払いの口から届いた知らせ（同じ知らせは 1 度だけ扱う）
create table if not exists ops.billing_events (
  id          text primary key,
  kind        text not null,
  received_at timestamptz not null default now()
);

-- カードの登録へ移るための 1 回限りの札（値の SHA-256 だけを持つ。10 分で切れる）
create table if not exists ops.billing_card_tickets (
  hash        text primary key,
  tenant_id   text not null,
  user_id     text not null,
  return_url  text not null,
  expires_at  timestamptz not null,
  used_at     timestamptz
);

-- 開発の途中の形から移す（未公開の間に先の形で入れたデータベースのため。新しいデータベースでは何もしない）
alter table ops.billing_settings add column if not exists monthly_price_jpy integer not null default 1800;
alter table ops.billing_settings add column if not exists annual_price_jpy integer not null default 1500;
alter table ops.billing_settings drop column if exists seat_price_jpy;
alter table ops.billing_accounts
  add column if not exists billing_class text not null default 'small_business',
  add column if not exists contract_term text,
  add column if not exists term_start date,
  add column if not exists term_end date,
  add column if not exists paid_seats integer not null default 0,
  add column if not exists annual_unit_jpy integer,
  add column if not exists annual_start_on date,
  add column if not exists next_term text,
  add column if not exists monthly_until text,
  add column if not exists seat_limit integer,
  add column if not exists fixed_annual_jpy integer,
  add column if not exists renewal_notice_for date,
  add column if not exists cancel_on date,
  drop column if exists cancel_month;
alter table ops.billing_invoices
  add column if not exists kind text not null default 'monthly',
  add column if not exists months integer not null default 1,
  add column if not exists term_start date,
  add column if not exists term_end date,
  drop constraint if exists billing_invoices_tenant_id_month_key;

-- 同じ月・同じ期間の請求を二度作らない
create unique index if not exists ops_billing_invoices_monthly on ops.billing_invoices (tenant_id, month) where kind = 'monthly';
create unique index if not exists ops_billing_invoices_term on ops.billing_invoices (tenant_id, term_start) where kind in ('annual', 'fixed');

grant select, update on ops.billing_settings to m2office_ops;
grant select on ops.billing_accounts, ops.billing_seat_peaks, ops.billing_invoices, ops.billing_seat_adds to m2office_ops;

-- ---- 月と人数 ----

create or replace function ops.billing_month(p_at timestamptz default now()) returns text
  language sql stable set search_path = pg_catalog as $$
  select to_char(p_at at time zone 'Asia/Tokyo', 'YYYY-MM');
$$;

create or replace function ops.billing_today() returns date
  language sql stable set search_path = pg_catalog as $$
  select (now() at time zone 'Asia/Tokyo')::date;
$$;

-- 契約の終わりまでの月数。1 か月に満たない分は切り上げる（@m2office/shared の remainingMonths と同じ計算）
create or replace function ops.billing_term_months(p_from date, p_term_end date) returns integer
  language sql immutable set search_path = pg_catalog as $$
  select (extract(year from a) * 12 + extract(month from a) + case when extract(day from a) > 0 then 1 else 0 end)::integer
    from age((p_term_end + 1)::timestamp, p_from::timestamp) a;
$$;

-- 契約した日から 12 か月の最後の日
create or replace function ops.billing_term_end(p_start date) returns date
  language sql immutable set search_path = pg_catalog as $$
  select ((p_start + interval '12 months')::date - 1);
$$;

-- クラスの上限（招待中の人も数える）。null は上限なし（@m2office/shared の定数と同じ値）
create or replace function ops.billing_user_limit(p_category text, p_class text, p_limit integer) returns integer
  language sql immutable set search_path = pg_catalog as $$
  select case
    when p_category = 'starter' then 1
    when p_category not in ('card', 'transfer') then null
    when p_class = 'small_business' then 21
    when p_class = 'business' then coalesce(p_limit, 50)
    else p_limit
  end;
$$;

create or replace function ops.billing_seat_count(p_tenant text) returns integer
  language sql stable security definer set search_path = pg_catalog, public as $$
  select count(*)::int from users where tenant_id = p_tenant and status = 'active' and first_login_at is not null;
$$;

-- 請求を画面に渡す形
create or replace function ops.billing_invoice_json(i ops.billing_invoices) returns jsonb
  language sql stable set search_path = pg_catalog as $$
  select jsonb_build_object(
    'id', i.id, 'number', i.number, 'tenantId', i.tenant_id, 'month', i.month, 'kind', i.kind, 'seats', i.seats, 'months', i.months,
    'termStart', to_char(i.term_start, 'YYYY-MM-DD'), 'termEnd', to_char(i.term_end, 'YYYY-MM-DD'), 'unitPriceJpy', i.unit_price_jpy,
    'subtotalJpy', i.subtotal_jpy, 'taxPercent', i.tax_percent, 'taxJpy', i.tax_jpy, 'totalJpy', i.total_jpy,
    'method', i.method, 'status', i.status, 'chargeState', i.charge_state, 'chargeError', i.charge_error,
    'dueDate', to_char(i.due_date, 'YYYY-MM-DD'), 'issuedAt', i.issued_at, 'paidAt', i.paid_at, 'dunningStage', i.dunning_stage,
    'issuer', i.issuer, 'recipient', i.recipient);
$$;

-- 利用者の状態が変わるたびに、その月の最大を更新する（夜の集計に頼らない。第23.4.5節「作りの決まり」）
create or replace function m2o_billing_seats() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare
  v_tenant text := coalesce(new.tenant_id, old.tenant_id);
  v_now integer;
  v_before integer;
  a ops.billing_accounts;
  v_paid integer;
  v_today date := ops.billing_today();
  v_months integer;
begin
  if v_tenant like 'd-%' then return null; end if;
  v_now := ops.billing_seat_count(v_tenant);
  -- この変更で減ったなら、変更の前の人数も最大に入れる（月の初めに、その月の行がまだ無いまま減らしたときの取り漏らしを防ぐ）
  v_before := v_now;
  if tg_op <> 'INSERT' and old.status = 'active' and old.first_login_at is not null
     and (tg_op = 'DELETE' or new.status <> 'active') then
    v_before := v_now + 1;
  end if;
  insert into ops.billing_seat_peaks (tenant_id, month, peak) values (v_tenant, ops.billing_month(), greatest(v_now, v_before))
    on conflict (tenant_id, month) do update set peak = greatest(ops.billing_seat_peaks.peak, excluded.peak);
  -- 年間契約: 有料の人数が席を超えたら、その場で席を増やす（第23.4.5節「月間契約と年間契約」）
  select * into a from ops.billing_accounts where tenant_id = v_tenant for update;
  v_paid := v_now - 1;
  if found and a.category in ('card', 'transfer') and a.billing_class = 'small_business' and a.contract_term = 'annual' and v_paid > a.paid_seats then
    if a.term_start is null then
      -- 2 人目が使い始めた日が契約した日になる
      update ops.billing_accounts set term_start = v_today, term_end = ops.billing_term_end(v_today), paid_seats = v_paid, renewal_notice_for = null,
             annual_unit_jpy = (select annual_price_jpy from ops.billing_settings where id = 1), updated_at = now()
       where tenant_id = v_tenant;
    else
      -- 期間の請求を出した後に増えた席だけ、別に請求する（出す前なら、その請求に含まれる）
      if exists (select 1 from ops.billing_invoices i where i.tenant_id = v_tenant and i.kind = 'annual' and i.term_start = a.term_start) then
        v_months := ops.billing_term_months(v_today, a.term_end);
        if v_months > 0 then
          insert into ops.billing_seat_adds (tenant_id, added_on, seats, unit_price_jpy, months, term_start, term_end)
            values (v_tenant, v_today, v_paid - a.paid_seats, a.annual_unit_jpy, v_months, a.term_start, a.term_end);
        end if;
      end if;
      update ops.billing_accounts set paid_seats = v_paid, updated_at = now() where tenant_id = v_tenant;
    end if;
  end if;
  return null;
end $$;
drop trigger if exists billing_seats on users;
create trigger billing_seats after insert or delete or update of status, first_login_at on users
  for each row execute function m2o_billing_seats();

-- クラスの上限（スターターは 1 人）。アプリの作りに頼らず、データベースでも断る（第23.4.5節）。招待中の人も数える
create or replace function m2o_billing_starter_guard() returns trigger
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare
  a ops.billing_accounts;
  v_limit integer;
begin
  if new.status <> 'active' then return new; end if;
  -- 同時の招待で上限を越えないよう、請求の相手の行で順番にする
  select * into a from ops.billing_accounts where tenant_id = new.tenant_id for update;
  if not found then return new; end if;
  v_limit := ops.billing_user_limit(a.category, a.billing_class, a.seat_limit);
  if v_limit is not null
     and (select count(*) from users where tenant_id = new.tenant_id and id <> new.id and status = 'active') >= v_limit then
    raise exception '%', case when a.category = 'starter' then 'starter_limit' else 'class_limit' end;
  end if;
  return new;
end $$;
drop trigger if exists billing_starter_guard on users;
create trigger billing_starter_guard before insert or update of status on users
  for each row execute function m2o_billing_starter_guard();

-- ---- 申し込みの口（m2office_signup） ----

-- 受け付けているかと料金（公開してよいものだけ）
drop function if exists ops.signup_status();
create function ops.signup_status()
  returns table (open boolean, monthly_price_jpy integer, annual_price_jpy integer, tax_percent integer, terms_version text)
  language sql stable security definer set search_path = pg_catalog, ops as $$
  select signup_open and terms_version <> '' , monthly_price_jpy, annual_price_jpy, tax_percent, terms_version from ops.billing_settings where id = 1;
$$;

-- そのサブドメインの空き。解約した会社のものも再利用しない
create or replace function ops.signup_subdomain_free(p_subdomain text) returns boolean
  language sql stable security definer set search_path = pg_catalog, public as $$
  select not exists (select 1 from tenants where subdomain = p_subdomain or id = 't-' || p_subdomain);
$$;

-- そのドメインの会社のサブドメイン（1 つのドメインに 1 社。無ければ null）
create or replace function ops.signup_domain_tenant(p_domain text) returns text
  language sql stable security definer set search_path = pg_catalog, public as $$
  select subdomain from tenants where workspace_domain = p_domain limit 1;
$$;

-- 会社をスターターで作る（運営者が作るときと同じ関数を通す）
create or replace function ops.signup_provision(p_subdomain text, p_name text, p_domain text, p_admin text, p_terms text)
  returns text
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare
  v_tenant text;
  s ops.billing_settings;
begin
  select * into s from ops.billing_settings where id = 1;
  if not s.signup_open or s.terms_version = '' then raise exception 'signup_closed'; end if;
  if p_terms is distinct from s.terms_version then raise exception 'terms_changed'; end if;
  v_tenant := ops.create_tenant(p_subdomain, p_name, p_domain, p_admin, 'trial', 'signup');
  insert into ops.billing_accounts (tenant_id, category, billing_name, terms_version, terms_accepted_at, terms_accepted_by)
    values (v_tenant, 'starter', p_name, p_terms, now(), p_admin);
  insert into ops.audit (id, operator_id, action, target_type, target_id, detail)
    values (gen_random_uuid()::text, 'signup', 'tenant.signup', 'tenant', v_tenant,
            jsonb_build_object('subdomain', p_subdomain, 'domain', p_domain));
  return v_tenant;
end $$;

-- カードの登録の札を引き換える（1 回限り）
create or replace function ops.signup_card_take(p_hash text)
  returns table (tenant_id text, return_url text, customer_id text)
  language plpgsql security definer set search_path = pg_catalog, ops as $$
begin
  return query
    update ops.billing_card_tickets t set used_at = now()
     where t.hash = p_hash and t.used_at is null and t.expires_at > now()
    returning t.tenant_id, t.return_url,
      (select a.customer_id from ops.billing_accounts a where a.tenant_id = t.tenant_id);
end $$;

-- カードの登録が済んだ。失敗していた請求は課金し直す
create or replace function ops.signup_card_done(p_tenant text, p_customer text)
  returns void
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
begin
  perform ops.billing_become_paid(p_tenant, 'card', p_customer, 'signup');
  update ops.billing_invoices set charge_state = 'pending', charge_error = null, method = 'card'
   where tenant_id = p_tenant and status = 'open';
end $$;

-- 課金する請求（申し込みの口だけが鍵を持つ）
create or replace function ops.signup_charges_due(p_limit integer default 20)
  returns table (id text, tenant_id text, number text, total_jpy integer, customer_id text)
  language sql stable security definer set search_path = pg_catalog, ops as $$
  select i.id, i.tenant_id, i.number, i.total_jpy, a.customer_id
    from ops.billing_invoices i join ops.billing_accounts a using (tenant_id)
   where i.status = 'open' and i.method = 'card' and i.charge_state = 'pending' and a.customer_id is not null
   order by i.issued_at limit p_limit;
$$;

-- 課金の結果を書く。同じ知らせは 1 度だけ扱う（1 度目なら true）
create or replace function ops.signup_charge_result(p_event text, p_invoice text, p_ok boolean, p_payment text, p_error text)
  returns boolean
  language plpgsql security definer set search_path = pg_catalog, ops as $$
declare v_new integer;
begin
  insert into ops.billing_events (id, kind) values (p_event, case when p_ok then 'charge.succeeded' else 'charge.failed' end)
    on conflict (id) do nothing;
  get diagnostics v_new = row_count;
  if v_new = 0 then return false; end if;
  if p_ok then
    update ops.billing_invoices set status = 'paid', paid_at = now(), paid_by = 'card', charge_state = 'done',
           charge_error = null, provider_payment = p_payment
     where id = p_invoice and status = 'open';
  else
    -- カードの失敗は、失敗の知らせの日を期限とみなす（第23.4.5節「督促」）
    update ops.billing_invoices set charge_state = 'failed', charge_error = left(coalesce(p_error, ''), 200), due_date = least(due_date, (now() at time zone 'Asia/Tokyo')::date)
     where id = p_invoice and status = 'open';
  end if;
  return true;
end $$;

-- ---- 有料への切り替え（カード・振込の共通） ----

create or replace function ops.billing_become_paid(p_tenant text, p_method text, p_customer text, p_actor text)
  returns void
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare v_from text;
begin
  if p_method not in ('card', 'transfer') then raise exception 'method_invalid'; end if;
  select category into v_from from ops.billing_accounts where tenant_id = p_tenant for update;
  if v_from is null then raise exception 'not_billable'; end if;
  update ops.billing_accounts set category = p_method, customer_id = coalesce(p_customer, customer_id),
         contract_term = coalesce(contract_term, 'monthly'),
         billed_from = coalesce(billed_from, ops.billing_month()), updated_at = now()
   where tenant_id = p_tenant;
  update tenants set status = 'active' where id = p_tenant and status = 'trial';
  insert into audit_events (id, tenant_id, actor_type, actor_id, action, target_type, target_id, detail, occurred_at)
    values (gen_random_uuid()::text, p_tenant, 'system', p_actor, 'billing.method', 'tenant', p_tenant,
            jsonb_build_object('from', v_from, 'to', p_method), now());
end $$;

-- ---- 会社の管理者の画面（m2office_app。自分の会社だけを読む） ----

create or replace function m2o_billing_category(p_tenant text) returns text
  language sql stable security definer set search_path = pg_catalog, ops as $$
  select coalesce((select category from ops.billing_accounts where tenant_id = p_tenant), 'none');
$$;

create or replace function m2o_billing_view(p_tenant text) returns jsonb
  language sql stable security definer set search_path = pg_catalog, public, ops as $$
  select jsonb_build_object(
    'category', coalesce(a.category, 'none'),
    'billingName', coalesce(a.billing_name, ''),
    'cancelOn', to_char(a.cancel_on, 'YYYY-MM-DD'),
    'billingClass', case when coalesce(a.category, 'none') = 'starter' then 'starter' else coalesce(a.billing_class, 'small_business') end,
    'seatLimit', ops.billing_user_limit(coalesce(a.category, 'none'), a.billing_class, a.seat_limit),
    'invited', (select count(*)::int from users u where u.tenant_id = p_tenant and u.status = 'active' and u.first_login_at is null),
    'contractTerm', a.contract_term,
    'termStart', to_char(a.term_start, 'YYYY-MM-DD'),
    'termEnd', to_char(a.term_end, 'YYYY-MM-DD'),
    'paidSeats', coalesce(a.paid_seats, 0),
    'annualUnitJpy', a.annual_unit_jpy,
    'annualStartOn', to_char(a.annual_start_on, 'YYYY-MM-DD'),
    'nextTerm', a.next_term,
    'fixedAnnualJpy', a.fixed_annual_jpy,
    'today', to_char(ops.billing_today(), 'YYYY-MM-DD'),
    'contact', p.contact,
    'month', ops.billing_month(),
    'seats', ops.billing_seat_count(p_tenant),
    'peak', greatest(coalesce((select peak from ops.billing_seat_peaks p where p.tenant_id = p_tenant and p.month = ops.billing_month()), 0), ops.billing_seat_count(p_tenant)),
    'monthlyPriceJpy', s.monthly_price_jpy,
    'annualPriceJpy', s.annual_price_jpy,
    'taxPercent', s.tax_percent,
    'transferReady', s.bank_account <> '' and s.registration_no <> '',
    'invoices', coalesce((select jsonb_agg(ops.billing_invoice_json(i) order by i.issued_at desc) from ops.billing_invoices i where i.tenant_id = p_tenant), '[]'::jsonb)
  )
  from ops.billing_settings s
  cross join ops.operator_profile p
  left join ops.billing_accounts a on a.tenant_id = p_tenant
  where s.id = 1 and p.id = 1;
$$;

-- 振込を選ぶ。運営の確かめを待たない（第23.4.5節「銀行振込で払う」、Q-304）
create or replace function m2o_billing_choose_transfer(p_tenant text, p_user text, p_name text)
  returns void
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare s ops.billing_settings;
begin
  select * into s from ops.billing_settings where id = 1;
  if s.bank_account = '' or s.registration_no = '' then raise exception 'transfer_unavailable'; end if;
  perform ops.billing_become_paid(p_tenant, 'transfer', null, p_user);
  update ops.billing_accounts set billing_name = coalesce(nullif(trim(p_name), ''), billing_name) where tenant_id = p_tenant;
  update ops.billing_invoices set method = 'transfer', charge_state = null, charge_error = null
   where tenant_id = p_tenant and status = 'open' and charge_state is distinct from 'done';
end $$;

-- カードの登録へ移る札を作る（値は API が作り、ハッシュだけをここに置く）
create or replace function m2o_billing_card_ticket(p_tenant text, p_user text, p_hash text, p_return text, p_name text)
  returns void
  language plpgsql security definer set search_path = pg_catalog, ops as $$
begin
  if not exists (select 1 from ops.billing_accounts where tenant_id = p_tenant) then raise exception 'not_billable'; end if;
  update ops.billing_accounts set billing_name = coalesce(nullif(trim(p_name), ''), billing_name) where tenant_id = p_tenant;
  delete from ops.billing_card_tickets where expires_at < now();
  insert into ops.billing_card_tickets (hash, tenant_id, user_id, return_url, expires_at) values (p_hash, p_tenant, p_user, p_return, now() + interval '10 minutes');
end $$;

-- 契約の形を選ぶ（第23.4.5節「月間契約と年間契約」）。お金に関わるので管理者が決める
create or replace function m2o_billing_set_term(p_tenant text, p_user text, p_term text)
  returns void
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare a ops.billing_accounts;
begin
  if p_term not in ('monthly', 'annual') then raise exception 'term_invalid'; end if;
  select * into a from ops.billing_accounts where tenant_id = p_tenant for update;
  if not found or a.category = 'none' then raise exception 'not_billable'; end if;
  if a.billing_class <> 'small_business' then raise exception 'contract_by_operator'; end if;
  if a.category = 'starter' then
    update ops.billing_accounts set contract_term = p_term, updated_at = now() where tenant_id = p_tenant;
  elsif p_term = 'annual' then
    if a.contract_term = 'annual' then
      update ops.billing_accounts set next_term = null, updated_at = now() where tenant_id = p_tenant;
    else
      -- 月間から年間へは翌月 1 日から（その月は月間のまま請求する）
      update ops.billing_accounts set annual_start_on = (date_trunc('month', ops.billing_today()) + interval '1 month')::date, updated_at = now() where tenant_id = p_tenant;
    end if;
  elsif a.contract_term = 'annual' then
    if a.term_start is null then
      update ops.billing_accounts set contract_term = 'monthly', billed_from = ops.billing_month(), monthly_until = null, paid_seats = 0, next_term = null, updated_at = now() where tenant_id = p_tenant;
    else
      -- 年間から月間へは更新のときだけ
      update ops.billing_accounts set next_term = 'monthly', updated_at = now() where tenant_id = p_tenant;
    end if;
  else
    update ops.billing_accounts set annual_start_on = null, updated_at = now() where tenant_id = p_tenant;
  end if;
  insert into audit_events (id, tenant_id, actor_type, actor_id, action, target_type, target_id, detail, occurred_at)
    values (gen_random_uuid()::text, p_tenant, 'user', p_user, 'billing.term', 'tenant', p_tenant, jsonb_build_object('term', p_term), now());
end $$;

-- 解約を申し出る・取り下げる。月間はその月の末、年間は契約の終わりの日まで使える（第23.4.5節）。返すのは使える最後の日
create or replace function m2o_billing_set_cancel(p_tenant text, p_user text, p_cancel boolean)
  returns text
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare
  a ops.billing_accounts;
  v_on date;
begin
  select * into a from ops.billing_accounts where tenant_id = p_tenant for update;
  if not found then raise exception 'not_billable'; end if;
  if a.billing_class <> 'small_business' then raise exception 'contract_by_operator'; end if;
  if p_cancel then
    v_on := case when a.contract_term = 'annual' and a.term_start is not null then a.term_end
                 else (date_trunc('month', ops.billing_today()) + interval '1 month' - interval '1 day')::date end;
  end if;
  update ops.billing_accounts set cancel_on = v_on, annual_start_on = case when p_cancel then null else annual_start_on end, updated_at = now() where tenant_id = p_tenant;
  insert into audit_events (id, tenant_id, actor_type, actor_id, action, target_type, target_id, detail, occurred_at)
    values (gen_random_uuid()::text, p_tenant, 'user', p_user, case when p_cancel then 'billing.cancel' else 'billing.cancel_undo' end, 'tenant', p_tenant,
            jsonb_build_object('on', v_on), now());
  return to_char(v_on, 'YYYY-MM-DD');
end $$;

-- ---- ワーカー（m2office_app） ----

-- 発行者の情報が揃っているか（運営主体と登録番号。揃うまで請求書を出さない）
create or replace function m2o_billing_issuer_ready() returns boolean
  language sql stable security definer set search_path = pg_catalog, ops as $$
  select p.name_ja <> '' and s.registration_no <> ''
    from ops.operator_profile p, ops.billing_settings s where p.id = 1 and s.id = 1;
$$;

-- 今月の行が無い会社に、いまの人数を置く（その月に誰も増減しなかった会社の人数を残す）。
-- あわせて、月間から年間への移りと、年間契約の更新を進める。請求は締めで作る
create or replace function m2o_billing_roll() returns integer
  language plpgsql security definer set search_path = pg_catalog, ops as $$
declare
  v_n integer;
  a ops.billing_accounts;
  v_today date := ops.billing_today();
  v_paid integer;
  v_start date;
  v_unit integer;
begin
  insert into ops.billing_seat_peaks (tenant_id, month, peak)
    select x.tenant_id, ops.billing_month(), ops.billing_seat_count(x.tenant_id)
      from ops.billing_accounts x where x.category in ('card', 'transfer') and x.cancelled_at is null
    on conflict (tenant_id, month) do nothing;
  get diagnostics v_n = row_count;
  select annual_price_jpy into v_unit from ops.billing_settings where id = 1;

  -- 月間から年間へ（翌月 1 日から 12 か月）
  for a in select * from ops.billing_accounts x
            where x.annual_start_on <= v_today and x.category in ('card', 'transfer') and x.cancelled_at is null for update loop
    v_paid := greatest(ops.billing_seat_count(a.tenant_id) - 1, 0);
    v_start := a.annual_start_on;
    update ops.billing_accounts set contract_term = 'annual', annual_start_on = null,
           monthly_until = to_char(v_start - 1, 'YYYY-MM'), paid_seats = v_paid, annual_unit_jpy = v_unit, renewal_notice_for = null,
           term_start = case when v_paid > 0 then v_start end, term_end = case when v_paid > 0 then ops.billing_term_end(v_start) end, updated_at = now()
     where tenant_id = a.tenant_id;
  end loop;

  -- 年間契約の更新（解約の申し出があれば更新しない）
  for a in select * from ops.billing_accounts x
            where x.contract_term = 'annual' and x.term_end < v_today and x.cancel_on is null
              and x.category in ('card', 'transfer') and x.cancelled_at is null for update loop
    v_start := a.term_end + 1;
    if a.billing_class <> 'small_business' then
      -- 定額は同じ額で続ける
      update ops.billing_accounts set term_start = v_start, term_end = ops.billing_term_end(v_start), renewal_notice_for = null, updated_at = now() where tenant_id = a.tenant_id;
    elsif a.next_term = 'monthly' then
      -- 期間の終わりの翌月から月間の請求を始める（同じ月を二重にいただかない）
      update ops.billing_accounts set contract_term = 'monthly', next_term = null, term_start = null, term_end = null, paid_seats = 0, annual_unit_jpy = null,
             billed_from = to_char(date_trunc('month', a.term_end) + interval '1 month', 'YYYY-MM'), monthly_until = null, renewal_notice_for = null, updated_at = now()
       where tenant_id = a.tenant_id;
    else
      v_paid := greatest(ops.billing_seat_count(a.tenant_id) - 1, 0);
      -- 1 人なら更新しない。2 人目が使い始めた日から新しい期間が始まる
      update ops.billing_accounts set paid_seats = v_paid, annual_unit_jpy = v_unit, renewal_notice_for = null,
             term_start = case when v_paid > 0 then v_start end, term_end = case when v_paid > 0 then ops.billing_term_end(v_start) end, updated_at = now()
       where tenant_id = a.tenant_id;
    end if;
  end loop;
  return v_n;
end $$;

-- 請求を 1 通作る（締めから呼ぶ）。単価と税率と発行者を請求に写す
create or replace function ops.billing_make_invoice(a ops.billing_accounts, p_kind text, p_month text, p_seats integer, p_unit integer, p_months integer, p_subtotal integer, p_term_start date, p_term_end date)
  returns ops.billing_invoices
  language plpgsql set search_path = pg_catalog, public, ops as $$
declare
  s ops.billing_settings;
  p ops.operator_profile;
  v_day date := ops.billing_today();
  v_tax integer;
  v_inv ops.billing_invoices;
begin
  select * into s from ops.billing_settings where id = 1;
  select * into p from ops.operator_profile where id = 1;
  -- 消費税は請求書ごとに 1 回計算し、1 円未満を切り捨てる
  v_tax := floor(p_subtotal * s.tax_percent / 100.0);
  insert into ops.billing_invoices (id, number, tenant_id, month, kind, seats, months, term_start, term_end, unit_price_jpy, subtotal_jpy, tax_percent, tax_jpy, total_jpy,
         method, charge_state, due_date, issuer, recipient)
    values (gen_random_uuid()::text, 'M2O-' || replace(p_month, '-', '') || '-' || lpad(nextval('ops.billing_invoice_seq')::text, 5, '0'),
            a.tenant_id, p_month, p_kind, p_seats, p_months, p_term_start, p_term_end, p_unit, p_subtotal, s.tax_percent, v_tax, p_subtotal + v_tax,
            a.category, case when a.category = 'card' then 'pending' end,
            -- 振込は月末締め翌月末払い（請求書を出した月の末日）。カードは発行の日
            case when a.category = 'transfer' then (date_trunc('month', v_day) + interval '1 month' - interval '1 day')::date else v_day end,
            jsonb_build_object('name', p.name_ja, 'postalCode', p.postal_code, 'address', p.address, 'contact', p.contact,
                               'registrationNo', s.registration_no, 'bankAccount', case when a.category = 'transfer' then s.bank_account else '' end),
            jsonb_build_object('name', a.billing_name))
    returning * into v_inv;
  return v_inv;
end $$;

-- 締め。作った請求を返す。何度呼んでも同じ請求を二度作らない（第23.4.5節「請求の正と毎月の流れ」）
--   月間契約: 先月までで請求の無い月。有料の人数が 0 人の月は作らない
--   年間契約: 先月までに始まった期間の 12 か月分と、先月までに増えた席
--   ビジネスとエンタープライズ: 先月までに始まった期間の年額
create or replace function m2o_billing_close()
  returns setof jsonb
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare
  s ops.billing_settings;
  p ops.operator_profile;
  a ops.billing_accounts;
  g record;
  v_month text;
  v_to date;
  v_paid integer;
  v_day date := ops.billing_today();
  v_this_month date := date_trunc('month', v_day)::date;
  v_inv ops.billing_invoices;
begin
  select * into s from ops.billing_settings where id = 1;
  select * into p from ops.operator_profile where id = 1;
  if p.name_ja = '' or s.registration_no = '' then return; end if;
  for a in select * from ops.billing_accounts where category in ('card', 'transfer') loop
    -- 月間契約
    if a.billed_from is not null and (coalesce(a.contract_term, 'monthly') = 'monthly' or a.monthly_until is not null) then
      v_to := (v_this_month - interval '1 month')::date;
      if a.monthly_until is not null then v_to := least(v_to, to_date(a.monthly_until, 'YYYY-MM')); end if;
      if a.cancel_on is not null then v_to := least(v_to, date_trunc('month', a.cancel_on)::date); end if;
      for v_month in
        select to_char(m, 'YYYY-MM') from generate_series(to_date(a.billed_from, 'YYYY-MM'), v_to, interval '1 month') m
      loop
        continue when exists (select 1 from ops.billing_invoices i where i.tenant_id = a.tenant_id and i.kind = 'monthly' and i.month = v_month);
        -- 最初の 1 人はずっと無料（第23.4.5節、Q-300）
        v_paid := coalesce((select peak from ops.billing_seat_peaks k where k.tenant_id = a.tenant_id and k.month = v_month), ops.billing_seat_count(a.tenant_id)) - 1;
        continue when v_paid <= 0;
        v_inv := ops.billing_make_invoice(a, 'monthly', v_month, v_paid, s.monthly_price_jpy, 1, v_paid * s.monthly_price_jpy, null, null);
        return next ops.billing_invoice_json(v_inv);
      end loop;
    end if;
    -- 期間の請求（先月までに始まった期間）
    if a.contract_term = 'annual' and a.term_start is not null and a.term_start < v_this_month
       and not exists (select 1 from ops.billing_invoices i where i.tenant_id = a.tenant_id and i.term_start = a.term_start and i.kind in ('annual', 'fixed')) then
      if a.billing_class = 'small_business' then
        if a.paid_seats > 0 then
          v_inv := ops.billing_make_invoice(a, 'annual', to_char(v_day, 'YYYY-MM'), a.paid_seats, a.annual_unit_jpy, 12, a.paid_seats * a.annual_unit_jpy * 12, a.term_start, a.term_end);
          return next ops.billing_invoice_json(v_inv);
        end if;
      elsif a.fixed_annual_jpy is not null then
        v_inv := ops.billing_make_invoice(a, 'fixed', to_char(v_day, 'YYYY-MM'), coalesce(a.seat_limit, 0), a.fixed_annual_jpy, 12, a.fixed_annual_jpy, a.term_start, a.term_end);
        return next ops.billing_invoice_json(v_inv);
      end if;
    end if;
    -- 先月までに増えた席（残りの月数が同じものを 1 通にまとめる）
    for g in
      select x.unit_price_jpy, x.months, x.term_start, x.term_end, sum(x.seats)::integer as seats, array_agg(x.id) as ids
        from ops.billing_seat_adds x
       where x.tenant_id = a.tenant_id and x.invoice_id is null and x.added_on < v_this_month
       group by x.unit_price_jpy, x.months, x.term_start, x.term_end
    loop
      v_inv := ops.billing_make_invoice(a, 'annual_add', to_char(v_day, 'YYYY-MM'), g.seats, g.unit_price_jpy, g.months, g.seats * g.unit_price_jpy * g.months, g.term_start, g.term_end);
      update ops.billing_seat_adds set invoice_id = v_inv.id where id = any (g.ids);
      return next ops.billing_invoice_json(v_inv);
    end loop;
  end loop;
end $$;

-- 更新の知らせ（終わる 30 日前から。期間ごとに 1 度だけ）
create or replace function m2o_billing_renewal_notices()
  returns table (tenant_id text, term_end text, next_term text)
  language plpgsql security definer set search_path = pg_catalog, ops as $$
begin
  return query
    update ops.billing_accounts a set renewal_notice_for = a.term_start
     where a.contract_term = 'annual' and a.term_start is not null and a.cancel_on is null and a.cancelled_at is null
       and a.category in ('card', 'transfer') and a.term_end - ops.billing_today() <= 30
       and a.renewal_notice_for is distinct from a.term_start
    returning a.tenant_id, to_char(a.term_end, 'YYYY-MM-DD'), a.next_term;
end $$;

-- 督促（期限の翌日・7 日後・14 日後。1 段ずつ進め、進めた請求を返す）
create or replace function m2o_billing_dunning()
  returns table (invoice_id text, tenant_id text, number text, total_jpy integer, stage integer)
  language plpgsql security definer set search_path = pg_catalog, ops as $$
declare v_today date := (now() at time zone 'Asia/Tokyo')::date;
begin
  return query
    update ops.billing_invoices i set dunning_stage = n.stage
      from (
        select x.id, case when v_today - x.due_date >= 14 then 3 when v_today - x.due_date >= 7 then 2 else 1 end as stage
          from ops.billing_invoices x
         where x.status = 'open' and x.due_date < v_today
      ) n
     where i.id = n.id and n.stage > i.dunning_stage
    returning i.id, i.tenant_id, i.number, i.total_jpy, i.dunning_stage;
end $$;

-- 解約の申し出の日が過ぎた会社を解約済みにする。返すのは解約済みにした数
create or replace function m2o_billing_apply_cancels() returns integer
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare r record; v_n integer := 0;
begin
  for r in
    select a.tenant_id from ops.billing_accounts a join tenants t on t.id = a.tenant_id
     where a.cancel_on is not null and a.cancel_on < ops.billing_today() and t.status <> 'cancelled'
  loop
    update tenants set status = 'cancelled' where id = r.tenant_id;
    update ops.billing_accounts set cancelled_at = now(), updated_at = now() where tenant_id = r.tenant_id;
    insert into audit_events (id, tenant_id, actor_type, actor_id, action, target_type, target_id, detail, occurred_at)
      values (gen_random_uuid()::text, r.tenant_id, 'system', 'billing', 'tenant.cancelled', 'tenant', r.tenant_id, jsonb_build_object('reason', 'requested'), now());
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- 長く使われないスターター（180 日で知らせ、さらに 30 日で解約済み。第23.4.5節、Q-302）
create or replace function m2o_billing_idle_starters()
  returns table (tenant_id text, action text)
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare r record; v_last timestamptz;
begin
  for r in
    select a.tenant_id, a.idle_notice_at, t.created_at from ops.billing_accounts a join tenants t on t.id = a.tenant_id
     where a.category = 'starter' and t.status = 'trial'
  loop
    select coalesce(max(s.last_seen_at), r.created_at) into v_last from sessions s where s.tenant_id = r.tenant_id;
    if r.idle_notice_at is not null and v_last > r.idle_notice_at then
      update ops.billing_accounts set idle_notice_at = null where billing_accounts.tenant_id = r.tenant_id;
    elsif r.idle_notice_at is not null and r.idle_notice_at < now() - interval '30 days' then
      update tenants set status = 'cancelled' where id = r.tenant_id;
      update ops.billing_accounts set cancelled_at = now(), updated_at = now() where billing_accounts.tenant_id = r.tenant_id;
      insert into audit_events (id, tenant_id, actor_type, actor_id, action, target_type, target_id, detail, occurred_at)
        values (gen_random_uuid()::text, r.tenant_id, 'system', 'billing', 'tenant.cancelled', 'tenant', r.tenant_id, jsonb_build_object('reason', 'idle'), now());
      tenant_id := r.tenant_id; action := 'cancelled'; return next;
    elsif r.idle_notice_at is null and v_last < now() - interval '180 days' then
      update ops.billing_accounts set idle_notice_at = now() where billing_accounts.tenant_id = r.tenant_id;
      tenant_id := r.tenant_id; action := 'notice'; return next;
    end if;
  end loop;
end $$;

-- ---- マスター管理画面（m2office_ops） ----

drop function if exists ops.billing_list();
create function ops.billing_list()
  returns table (tenant_id text, subdomain text, name text, status text, category text, cancel_on text, seats integer,
                 billing_class text, contract_term text, term_start text, term_end text, paid_seats integer, seat_limit integer, fixed_annual_jpy integer, invoices jsonb)
  language sql stable security definer set search_path = pg_catalog, public, ops as $$
  select t.id, t.subdomain, t.name, t.status, coalesce(a.category, 'none'), to_char(a.cancel_on, 'YYYY-MM-DD'), ops.billing_seat_count(t.id),
         coalesce(a.billing_class, 'small_business'), a.contract_term, to_char(a.term_start, 'YYYY-MM-DD'), to_char(a.term_end, 'YYYY-MM-DD'),
         coalesce(a.paid_seats, 0), a.seat_limit, a.fixed_annual_jpy,
         coalesce((select jsonb_agg(l.j) from (select ops.billing_invoice_json(x) as j from ops.billing_invoices x where x.tenant_id = t.id order by x.issued_at desc limit 6) l), '[]'::jsonb)
    from tenants t left join ops.billing_accounts a on a.tenant_id = t.id
   where t.id not like 'd-%'
   order by t.created_at;
$$;

-- 入金済みにする（お金の確定は人が行う。第23.4.5節「銀行振込で払う」）
create or replace function ops.billing_mark_paid(p_invoice text, p_operator text)
  returns void
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare v_tenant text;
begin
  update ops.billing_invoices set status = 'paid', paid_at = now(), paid_by = p_operator
   where id = p_invoice and status = 'open' returning tenant_id into v_tenant;
  if v_tenant is null then raise exception 'not_open'; end if;
  insert into audit_events (id, tenant_id, actor_type, actor_id, action, target_type, target_id, detail, occurred_at)
    values (gen_random_uuid()::text, v_tenant, 'system', 'ops:' || p_operator, 'billing.paid', 'invoice', p_invoice, '{}'::jsonb, now());
end $$;

-- 請求の区分を変える（運営者が作った会社を有料に移す・見せる用の会社を請求しないにする）
create or replace function ops.billing_set_category(p_tenant text, p_category text, p_operator text)
  returns void
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
begin
  if p_category not in ('starter', 'card', 'transfer', 'none') then raise exception 'category_invalid'; end if;
  if not exists (select 1 from tenants where id = p_tenant) then raise exception 'not_found'; end if;
  insert into ops.billing_accounts (tenant_id, category, billing_name, billed_from)
    values (p_tenant, p_category, (select name from tenants where id = p_tenant), case when p_category in ('card', 'transfer') then ops.billing_month() end)
    on conflict (tenant_id) do update set category = excluded.category, updated_at = now(),
      billed_from = coalesce(ops.billing_accounts.billed_from, excluded.billed_from);
  insert into audit_events (id, tenant_id, actor_type, actor_id, action, target_type, target_id, detail, occurred_at)
    values (gen_random_uuid()::text, p_tenant, 'system', 'ops:' || p_operator, 'billing.category', 'tenant', p_tenant,
            jsonb_build_object('category', p_category), now());
end $$;

-- ビジネスとエンタープライズの契約を入れる（第23.4.5節）。金額は交渉で決まるので、運営者が契約ごとに入れる。
-- スモールビジネスへ戻すときは月間契約に戻す（更新のときに行う）
create or replace function ops.billing_set_contract(p_tenant text, p_class text, p_limit integer, p_annual integer, p_start date, p_operator text)
  returns void
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare
  a ops.billing_accounts;
  v_limit integer;
  v_start date := coalesce(p_start, ops.billing_today());
  v_users integer;
begin
  if p_class not in ('small_business', 'business', 'enterprise') then raise exception 'class_invalid'; end if;
  select * into a from ops.billing_accounts where tenant_id = p_tenant for update;
  if not found then raise exception 'not_found'; end if;
  if a.category not in ('card', 'transfer') then raise exception 'method_required'; end if;
  -- ビジネスの上限は 50 人に固定。入れた上限を使うのはエンタープライズだけ
  v_limit := ops.billing_user_limit(a.category, p_class, case when p_class = 'enterprise' then p_limit end);
  select count(*) into v_users from users where tenant_id = p_tenant and status = 'active';
  if v_limit is not null and v_users > v_limit then raise exception 'over_limit'; end if;
  if p_class = 'small_business' then
    update ops.billing_accounts set billing_class = p_class, seat_limit = null, fixed_annual_jpy = null, contract_term = 'monthly',
           term_start = null, term_end = null, paid_seats = 0, annual_unit_jpy = null, annual_start_on = null, next_term = null,
           billed_from = ops.billing_month(), monthly_until = null, renewal_notice_for = null, updated_at = now()
     where tenant_id = p_tenant;
  else
    if p_annual is null or p_annual <= 0 then raise exception 'amount_required'; end if;
    update ops.billing_accounts set billing_class = p_class, seat_limit = v_limit, fixed_annual_jpy = p_annual, contract_term = 'annual',
           term_start = v_start, term_end = ops.billing_term_end(v_start), paid_seats = 0, annual_unit_jpy = null, annual_start_on = null, next_term = null,
           -- 月間契約なら、その月までの分を月間の請求で出す
           monthly_until = case when coalesce(a.contract_term, 'monthly') = 'monthly' then ops.billing_month() else a.monthly_until end,
           renewal_notice_for = null, updated_at = now()
     where tenant_id = p_tenant;
  end if;
  insert into audit_events (id, tenant_id, actor_type, actor_id, action, target_type, target_id, detail, occurred_at)
    values (gen_random_uuid()::text, p_tenant, 'system', 'ops:' || p_operator, 'billing.contract', 'tenant', p_tenant,
            jsonb_build_object('class', p_class, 'limit', v_limit, 'annualJpy', p_annual, 'start', v_start), now());
end $$;

-- 定額の契約を更新しない・取り下げる（契約の終わりの日まで使える）
create or replace function ops.billing_set_cancel(p_tenant text, p_cancel boolean, p_operator text)
  returns text
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare
  a ops.billing_accounts;
  v_on date;
begin
  select * into a from ops.billing_accounts where tenant_id = p_tenant for update;
  if not found then raise exception 'not_found'; end if;
  if p_cancel then
    v_on := coalesce(a.term_end, (date_trunc('month', ops.billing_today()) + interval '1 month' - interval '1 day')::date);
  end if;
  update ops.billing_accounts set cancel_on = v_on, updated_at = now() where tenant_id = p_tenant;
  insert into audit_events (id, tenant_id, actor_type, actor_id, action, target_type, target_id, detail, occurred_at)
    values (gen_random_uuid()::text, p_tenant, 'system', 'ops:' || p_operator, case when p_cancel then 'billing.cancel' else 'billing.cancel_undo' end, 'tenant', p_tenant,
            jsonb_build_object('on', v_on), now());
  return to_char(v_on, 'YYYY-MM-DD');
end $$;

-- ---- 権限 ----

do $$
declare f text;
begin
  foreach f in array array[
    'ops.signup_status()', 'ops.signup_subdomain_free(text)', 'ops.signup_domain_tenant(text)',
    'ops.signup_provision(text, text, text, text, text)', 'ops.signup_card_take(text)', 'ops.signup_card_done(text, text)',
    'ops.signup_charges_due(integer)', 'ops.signup_charge_result(text, text, boolean, text, text)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to m2office_signup', f);
  end loop;
  -- 内部で使う関数は、どのロールからも直接は呼ばせない
  foreach f in array array[
    'ops.billing_become_paid(text, text, text, text)',
    'ops.billing_make_invoice(ops.billing_accounts, text, text, integer, integer, integer, integer, date, date)'
  ] loop
    execute format('revoke all on function %s from public', f);
  end loop;
  foreach f in array array[
    'ops.billing_list()', 'ops.billing_mark_paid(text, text)', 'ops.billing_set_category(text, text, text)',
    'ops.billing_set_contract(text, text, integer, integer, date, text)', 'ops.billing_set_cancel(text, boolean, text)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to m2office_ops', f);
  end loop;
  foreach f in array array[
    'm2o_billing_category(text)', 'm2o_billing_view(text)', 'm2o_billing_choose_transfer(text, text, text)',
    'm2o_billing_card_ticket(text, text, text, text, text)', 'm2o_billing_set_cancel(text, text, boolean)', 'm2o_billing_set_term(text, text, text)',
    'm2o_billing_renewal_notices()',
    'm2o_billing_issuer_ready()', 'm2o_billing_roll()', 'm2o_billing_close()', 'm2o_billing_dunning()',
    'm2o_billing_apply_cancels()', 'm2o_billing_idle_starters()'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to m2office_app', f);
  end loop;
end $$;
