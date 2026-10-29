-- 体験版を自分で申し込む（仕様書 第23.3.2節「自分で申し込む」、Q-289、ADR-0117。第 0.488.0 版）
--
-- 体験版の入口の申し込みの画面から、会社名・お名前・メールアドレスと規約への同意だけで、体験用の会社を作る。
-- アプリのロールに渡すのは、既定の日数と上限で体験用の会社を 1 つ作る関数（m2o_demo_self_signup）だけ。顧客の会社は作れない。
-- 歯止め（同じメールアドレスは一度だけ・同じ送り元は 24 時間に 1 件・1 日の数・体験版全体の月の AI の上限）は、すべてこの関数の中で見る。
-- メールアドレスと送り元は、運営の秘密を混ぜたハッシュで持つ（元に戻せない）。メールアドレスのハッシュは、相手の情報を消した後も残す。
-- 巻き戻し: 関数 m2o_demo_self_signup・ops.set_demo_signup を消し、表 ops.demo_signup_secret・ops.demo_signup_emails・
-- ops.demo_signup_sources・ops.demo_ai_months を消し、ops.demo_guests から origin の列を、ops.platform_settings から
-- demo_self_signup・demo_daily_limit・demo_monthly_ai_cap_jpy の列を消す。m2o_demo_purge は移行 172 のものに戻す。
-- 出し方（origin）は、運営のロールが ops.demo_guests を直接読む（ops.list_demos の返す形は変えない。移行は毎回はじめから流すため）。

alter table ops.platform_settings add column if not exists demo_self_signup boolean not null default true;
alter table ops.platform_settings add column if not exists demo_daily_limit integer not null default 20 check (demo_daily_limit between 0 and 1000);
alter table ops.platform_settings add column if not exists demo_monthly_ai_cap_jpy numeric(12, 0) not null default 20000 check (demo_monthly_ai_cap_jpy >= 0);

-- 出し方（運営が出した ops・自分で申し込み self）
alter table ops.demo_guests add column if not exists origin text not null default 'ops';
alter table ops.demo_guests drop constraint if exists demo_guests_origin_check;
alter table ops.demo_guests add constraint demo_guests_origin_check check (origin in ('ops', 'self'));

-- ハッシュに混ぜる運営の秘密（どのロールにも読ませない。関数の中だけで使う）
create table if not exists ops.demo_signup_secret (
  id      integer primary key check (id = 1),
  pepper  text not null
);
insert into ops.demo_signup_secret (id, pepper) values (1, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  on conflict (id) do nothing;

-- 申し込みに使ったメールアドレスの控え（消さない。同じ人は一度だけ）
create table if not exists ops.demo_signup_emails (
  email_hash  text primary key,
  created_at  timestamptz not null default now()
);

-- 申し込みの送り元の控え（24 時間で消す）
create table if not exists ops.demo_signup_sources (
  addr_hash   text not null,
  created_at  timestamptz not null default now()
);
create index if not exists ops_demo_signup_sources_addr on ops.demo_signup_sources (addr_hash, created_at);

-- 消した体験の会社の AI の利用（月ごとの合計）。会社を消すと ai_usage の行も消えるため、体験版全体の月の上限に数え続けるよう写す
create table if not exists ops.demo_ai_months (
  month  date primary key,
  jpy    numeric(14, 4) not null default 0
);

-- 体験用の会社を消す（移行 172 のものに、消す前に AI の利用を月ごとに写すことを足した）
create or replace function m2o_demo_purge(p_tenant text) returns boolean
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare r record;
begin
  if p_tenant not like 'd-%' or not exists (select 1 from tenants where id = p_tenant and kind = 'demo') then return false; end if;
  insert into ops.demo_ai_months (month, jpy)
    select date_trunc('month', a.at at time zone 'Asia/Tokyo')::date, sum(a.cost_jpy) from ai_usage a
     where a.tenant_id = p_tenant and not a.local group by 1
  on conflict (month) do update set jpy = ops.demo_ai_months.jpy + excluded.jpy;
  delete from tenants where id = p_tenant;
  for r in
    select c.table_schema, c.table_name from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
     where c.column_name = 'tenant_id' and c.table_schema in ('public', 'ops')
       and c.table_name not like 'evidence%' and not (c.table_schema = 'ops' and c.table_name = 'demo_guests')
       and not exists (select 1 from pg_inherits i join pg_class k on k.oid = i.inhrelid join pg_namespace n on n.oid = k.relnamespace
                        where n.nspname = c.table_schema and k.relname = c.table_name)
  loop
    execute format('delete from %I.%I where tenant_id = $1', r.table_schema, r.table_name) using p_tenant;
  end loop;
  update ops.demo_guests set deleted_at = now() where tenant_id = p_tenant and deleted_at is null;
  return true;
end $$;
revoke all on function m2o_demo_purge(text) from public;

-- 体験版全体の、その月（日本時間）の AI の利用（円）
create or replace function ops.demo_ai_month_total()
  returns numeric
  language sql stable security definer set search_path = pg_catalog, public, ops as $$
  select coalesce((select sum(a.cost_jpy) from ai_usage a
                    where a.tenant_id like 'd-%' and not a.local
                      and a.at >= (date_trunc('month', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo')), 0)
       + coalesce((select m.jpy from ops.demo_ai_months m where m.month = date_trunc('month', now() at time zone 'Asia/Tokyo')::date), 0);
$$;
revoke all on function ops.demo_ai_month_total() from public;
grant execute on function ops.demo_ai_month_total() to m2office_ops;

-- 運営: 自分で申し込む体験の設定（使うか・1 日の数・体験版全体の月の AI の上限）
create or replace function ops.set_demo_signup(p_enabled boolean, p_daily integer, p_monthly_cap numeric, p_operator text)
  returns void
  language plpgsql security definer set search_path = pg_catalog, ops as $$
begin
  if p_daily < 0 or p_daily > 1000 then raise exception 'daily_invalid'; end if;
  if p_monthly_cap < 0 then raise exception 'cap_invalid'; end if;
  update ops.platform_settings set demo_self_signup = p_enabled, demo_daily_limit = p_daily, demo_monthly_ai_cap_jpy = p_monthly_cap,
         updated_by = p_operator, updated_at = now() where id = 1;
end $$;
revoke all on function ops.set_demo_signup(boolean, integer, numeric, text) from public;
grant execute on function ops.set_demo_signup(boolean, integer, numeric, text) to m2office_ops;

-- アプリ: 自分で申し込む（既定の日数と上限で、体験用の会社を 1 つ作る）。
-- p_email_key はそろえた形のメールアドレス（大文字と小文字・+ の後ろ・Gmail の . をそろえたもの）、p_addr は送り元のアドレス。
-- 断る理由: signup_closed（使わない設定）・signup_invalid（入力）・signup_email_used・signup_source_used・signup_daily_limit・signup_budget
create or replace function m2o_demo_self_signup(p_login text, p_hash text, p_company text, p_contact text, p_email text,
                                                p_email_key text, p_addr text, p_name text)
  returns table (guest_id text, tenant_id text, user_id text, expires_at timestamptz)
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare
  s ops.platform_settings%rowtype;
  v_pepper text;
  v_email text;
  v_addr text;
  v_day timestamptz := date_trunc('day', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo';
  d record;
begin
  -- 同時の申し込みで数を越えないよう、申し込みを 1 件ずつ扱う
  perform pg_advisory_xact_lock(hashtext('m2o_demo_self_signup'));
  select * into s from ops.platform_settings where id = 1;
  if not coalesce(s.demo_self_signup, false) then raise exception 'signup_closed'; end if;
  if coalesce(btrim(p_company), '') = '' or length(p_company) > 100 or coalesce(btrim(p_contact), '') = '' or length(p_contact) > 100
     or coalesce(p_email_key, '') !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or length(p_email) > 200 or coalesce(p_addr, '') = '' then
    raise exception 'signup_invalid';
  end if;
  select pepper into v_pepper from ops.demo_signup_secret where id = 1;
  v_email := encode(sha256(convert_to(v_pepper || ':email:' || lower(p_email_key), 'UTF8')), 'hex');
  v_addr := encode(sha256(convert_to(v_pepper || ':addr:' || p_addr, 'UTF8')), 'hex');
  delete from ops.demo_signup_sources where created_at < now() - interval '24 hours';
  if exists (select 1 from ops.demo_signup_emails e where e.email_hash = v_email) then raise exception 'signup_email_used'; end if;
  if exists (select 1 from ops.demo_signup_sources x where x.addr_hash = v_addr) then raise exception 'signup_source_used'; end if;
  if (select count(*) from ops.demo_guests g where g.origin = 'self' and g.created_at >= v_day) >= s.demo_daily_limit then
    raise exception 'signup_daily_limit';
  end if;
  if ops.demo_ai_month_total() >= s.demo_monthly_ai_cap_jpy then raise exception 'signup_budget'; end if;
  select * into d from ops.create_demo(p_login, p_hash, btrim(p_company), btrim(p_contact), btrim(p_email), s.demo_days, s.demo_ai_cap_jpy, p_name, 'self-signup');
  update ops.demo_guests g set origin = 'self', terms_accepted_at = now() where g.id = d.guest_id;
  insert into ops.demo_signup_emails (email_hash) values (v_email);
  insert into ops.demo_signup_sources (addr_hash) values (v_addr);
  insert into ops.audit (id, operator_id, action, target_type, target_id, detail)
    values (gen_random_uuid()::text, 'self-signup', 'demo.self_signup', 'demo', d.guest_id,
            jsonb_build_object('loginId', p_login, 'days', s.demo_days, 'aiCapJpy', s.demo_ai_cap_jpy));
  return query select d.guest_id, d.tenant_id, 'u-' || p_login, d.expires_at;
end $$;
revoke all on function m2o_demo_self_signup(text, text, text, text, text, text, text, text) from public;
grant execute on function m2o_demo_self_signup(text, text, text, text, text, text, text, text) to m2office_app;
