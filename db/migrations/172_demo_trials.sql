-- 体験版（demo.m2office.net。仕様書 第23.3.2節、Q-286、ADR-0115）
--
-- 運営がゲストの ID とパスワードを出し、ゲストごとに使い捨ての「体験用の会社」を作る。体験用の会社の ID は `d-` で始め
-- （顧客の会社は `t-`）、印 `kind = 'demo'` を付ける。サブドメインは名前に使えない形（`_d-…`）にし、名前からは決まらない。
-- 会社一覧・毎晩の数には入れない。1 社に 1 人・会社の接続の情報は持たない・ファイルは 500 MB までを、表の仕掛けで守る（アプリの作りに頼らない）。
-- ゲストの表（ops.demo_guests）は運営のスキーマに置く。アプリのロールは決めた関数でだけ読み書きする（パスワードの控えは返すが、元には戻せない形）。
-- 巻き戻し: 関数・仕掛け・表 ops.demo_guests を消し、tenants から kind の列を、ops.platform_settings から demo_* の列を消す
-- （体験用の会社が残っていれば、先に m2o_demo_purge で消す）。

alter table tenants add column if not exists kind text not null default 'customer';
alter table tenants drop constraint if exists tenants_kind_check;
alter table tenants add constraint tenants_kind_check check (kind in ('customer', 'demo') and (kind = 'demo') = (id like 'd-%'));

-- 体験版の既定（マスター管理画面の「設定」の AI で変える）
alter table ops.platform_settings add column if not exists demo_days integer not null default 14 check (demo_days between 1 and 60);
alter table ops.platform_settings add column if not exists demo_ai_cap_jpy numeric(12, 0) not null default 1000 check (demo_ai_cap_jpy > 0);

create table if not exists ops.demo_guests (
  id               text primary key,
  -- ゲストの ID（guest- と英数字 6 文字）
  login_id         text not null unique,
  password_hash    text not null,
  tenant_id        text not null unique,
  user_id          text not null,
  -- 相手の情報（体験を終えてから 90 日で消す。件数と日付は残す）
  company          text not null default '',
  contact          text not null default '',
  email            text not null default '',
  ai_cap_jpy       numeric(12, 0) not null check (ai_cap_jpy > 0),
  created_by       text not null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  -- 早く終えた日時（運営者が終えた）
  ended_at         timestamptz,
  -- 体験用の会社を消した日時
  deleted_at       timestamptz,
  -- 相手の情報を消した日時
  contact_purged_at timestamptz,
  -- 見本のデータを入れ始めた・入れ終えた日時
  seeding_at       timestamptz,
  seeded_at        timestamptz,
  terms_accepted_at timestamptz,
  failed_count     integer not null default 0,
  locked_until     timestamptz,
  login_count      integer not null default 0,
  last_login_at    timestamptz,
  password_set_at  timestamptz not null default now()
);
create index if not exists ops_demo_guests_due on ops.demo_guests (expires_at) where deleted_at is null;
grant select on ops.demo_guests to m2office_ops;

-- 体験用の会社では、2 人目の利用者・会社の接続の情報・500 MB を超えるファイルを断る（第23.3.2節「ゲストのロール」「置ける量」）
create or replace function m2o_demo_guard() returns trigger language plpgsql as $$
begin
  if new.tenant_id not like 'd-%' then return new; end if;
  if tg_table_name = 'users' then
    if exists (select 1 from users where tenant_id = new.tenant_id and id <> new.id) then raise exception 'demo_restricted:users'; end if;
  elsif tg_table_name = 'files' then
    if (select coalesce(sum(size), 0) from files where tenant_id = new.tenant_id) + new.size > 500 * 1024 * 1024 then
      raise exception 'demo_restricted:storage';
    end if;
  else
    raise exception 'demo_restricted:connection';
  end if;
  return new;
end $$;
drop trigger if exists demo_guard on users;
create trigger demo_guard before insert on users for each row execute function m2o_demo_guard();
drop trigger if exists demo_guard on files;
create trigger demo_guard before insert on files for each row execute function m2o_demo_guard();
drop trigger if exists demo_guard on tenant_credentials;
create trigger demo_guard before insert or update on tenant_credentials for each row execute function m2o_demo_guard();
drop trigger if exists demo_guard on tenant_connections;
create trigger demo_guard before insert on tenant_connections for each row execute function m2o_demo_guard();

-- 体験用の会社を、データ・記録ごと消す（会社を持つ表はすべて。外部キーの無い表も、tenant_id の列で探して消す）。
-- 証拠保全したもの（evidence_*）は消さない（保全の決まりが先。第16.10.5節）。中のファイルの置き場は、呼んだワーカーが消す
create or replace function m2o_demo_purge(p_tenant text) returns boolean
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare r record;
begin
  if p_tenant not like 'd-%' or not exists (select 1 from tenants where id = p_tenant and kind = 'demo') then return false; end if;
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

-- 運営: 体験を出す（体験用の会社・ゲストの利用者・ゲストの記録を作る）。見本のデータは、最初のログインのときに API が入れる
create or replace function ops.create_demo(p_login text, p_hash text, p_company text, p_contact text, p_email text,
                                           p_days integer, p_ai_cap numeric, p_name text, p_operator text)
  returns table (guest_id text, tenant_id text, expires_at timestamptz)
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare
  v_key text := substr(md5(random()::text || clock_timestamp()::text), 1, 10);
  v_tenant text := 'd-' || v_key;
  v_user text := 'u-' || p_login;
  v_guest text := 'dg-' || v_key;
  v_expires timestamptz := now() + make_interval(days => p_days);
begin
  if p_login !~ '^guest-[a-z0-9]{6}$' then raise exception 'login_invalid'; end if;
  if p_days < 1 or p_days > 60 then raise exception 'days_invalid'; end if;
  if p_ai_cap <= 0 then raise exception 'cap_invalid'; end if;
  if exists (select 1 from ops.demo_guests g where g.login_id = p_login) then raise exception 'login_taken'; end if;
  insert into tenants (id, subdomain, name, workspace_domain, status, kind) values (v_tenant, '_' || v_tenant, p_name, null, 'trial', 'demo');
  insert into users (id, tenant_id, email, display_name, roles)
    values (v_user, v_tenant, p_login || '@demo.invalid', 'ゲスト', array['admin', 'approver', 'member']);
  insert into ops.demo_guests (id, login_id, password_hash, tenant_id, user_id, company, contact, email, ai_cap_jpy, created_by, expires_at)
    values (v_guest, p_login, p_hash, v_tenant, v_user, p_company, p_contact, p_email, p_ai_cap, p_operator, v_expires);
  return query select v_guest, v_tenant, v_expires;
end $$;

-- 運営: 体験の一覧（相手の情報と数だけ。体験用の会社の中身は返さない）
create or replace function ops.list_demos()
  returns table (id text, login_id text, tenant_id text, company text, contact text, email text, ai_cap_jpy numeric,
                 created_by text, created_at timestamptz, expires_at timestamptz, ended_at timestamptz, deleted_at timestamptz,
                 contact_purged_at timestamptz, terms_accepted_at timestamptz, login_count integer, last_login_at timestamptz,
                 locked_until timestamptz, ai_used_jpy numeric, files_bytes bigint)
  language sql stable security definer set search_path = pg_catalog, public, ops as $$
  select g.id, g.login_id, g.tenant_id, g.company, g.contact, g.email, g.ai_cap_jpy, g.created_by, g.created_at, g.expires_at,
         g.ended_at, g.deleted_at, g.contact_purged_at, g.terms_accepted_at, g.login_count, g.last_login_at, g.locked_until,
         (select coalesce(sum(a.cost_jpy), 0) from ai_usage a where a.tenant_id = g.tenant_id and not a.local),
         (select coalesce(sum(f.size), 0)::bigint from files f where f.tenant_id = g.tenant_id)
    from ops.demo_guests g
   order by g.created_at desc;
$$;

-- 運営: 期限を延ばす（1 回に 7 日まで。終えた・消した体験は延ばせない）
create or replace function ops.extend_demo(p_id text, p_days integer, p_operator text)
  returns timestamptz
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare v_at timestamptz;
begin
  if p_days < 1 or p_days > 7 then raise exception 'days_invalid'; end if;
  update ops.demo_guests g set expires_at = greatest(g.expires_at, now()) + make_interval(days => p_days)
   where g.id = p_id and g.ended_at is null and g.deleted_at is null
   returning g.expires_at into v_at;
  if v_at is null then raise exception 'not_found'; end if;
  return v_at;
end $$;

-- 運営: パスワードを出し直す（前のパスワードとログイン状態は使えなくなる）
create or replace function ops.reset_demo_password(p_id text, p_hash text, p_operator text)
  returns boolean
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare v_tenant text;
begin
  update ops.demo_guests g set password_hash = p_hash, password_set_at = now(), failed_count = 0, locked_until = null
   where g.id = p_id and g.ended_at is null and g.deleted_at is null and g.expires_at > now()
   returning g.tenant_id into v_tenant;
  if v_tenant is null then raise exception 'not_found'; end if;
  update sessions set revoked_at = now() where tenant_id = v_tenant and revoked_at is null;
  return true;
end $$;

-- 運営: 早く終える（すぐにログインできなくし、体験用の会社を消す）
create or replace function ops.end_demo(p_id text, p_operator text)
  returns text
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare v_tenant text;
begin
  update ops.demo_guests g set ended_at = now() where g.id = p_id and g.ended_at is null and g.deleted_at is null
   returning g.tenant_id into v_tenant;
  if v_tenant is null then raise exception 'not_found'; end if;
  perform m2o_demo_purge(v_tenant);
  return v_tenant;
end $$;

-- 運営: 体験版の既定（日数と AI の上限）
create or replace function ops.set_demo_defaults(p_days integer, p_ai_cap numeric, p_operator text)
  returns void
  language plpgsql security definer set search_path = pg_catalog, ops as $$
begin
  if p_days < 1 or p_days > 60 then raise exception 'days_invalid'; end if;
  if p_ai_cap <= 0 then raise exception 'cap_invalid'; end if;
  update ops.platform_settings set demo_days = p_days, demo_ai_cap_jpy = p_ai_cap, updated_by = p_operator, updated_at = now() where id = 1;
end $$;

revoke all on function ops.create_demo(text, text, text, text, text, integer, numeric, text, text) from public;
revoke all on function ops.list_demos() from public;
revoke all on function ops.extend_demo(text, integer, text) from public;
revoke all on function ops.reset_demo_password(text, text, text) from public;
revoke all on function ops.end_demo(text, text) from public;
revoke all on function ops.set_demo_defaults(integer, numeric, text) from public;
grant execute on function ops.create_demo(text, text, text, text, text, integer, numeric, text, text) to m2office_ops;
grant execute on function ops.list_demos() to m2office_ops;
grant execute on function ops.extend_demo(text, integer, text) to m2office_ops;
grant execute on function ops.reset_demo_password(text, text, text) to m2office_ops;
grant execute on function ops.end_demo(text, text) to m2office_ops;
grant execute on function ops.set_demo_defaults(integer, numeric, text) to m2office_ops;

-- アプリ: ログインのためにゲストを引く（使える状態のときだけ。パスワードの控えは元に戻せない形）
create or replace function m2o_demo_login_lookup(p_login text)
  returns table (guest_id text, tenant_id text, user_id text, password_hash text, expires_at timestamptz, locked_until timestamptz, seeded boolean)
  language sql stable security definer set search_path = pg_catalog, ops as $$
  select g.id, g.tenant_id, g.user_id, g.password_hash, g.expires_at, g.locked_until, g.seeded_at is not null
    from ops.demo_guests g
   where g.login_id = p_login and g.ended_at is null and g.deleted_at is null and g.expires_at > now();
$$;

-- アプリ: ログインの結果を残す（5 回続けて間違えたら 15 分止める）
create or replace function m2o_demo_login_result(p_guest text, p_ok boolean)
  returns void
  language plpgsql security definer set search_path = pg_catalog, ops as $$
begin
  if p_ok then
    update ops.demo_guests set failed_count = 0, locked_until = null, login_count = login_count + 1, last_login_at = now() where id = p_guest;
  else
    update ops.demo_guests
       set failed_count = case when failed_count + 1 >= 5 then 0 else failed_count + 1 end,
           locked_until = case when failed_count + 1 >= 5 then now() + interval '15 minutes' else locked_until end
     where id = p_guest;
  end if;
end $$;

-- アプリ: 見本のデータを入れる番を取る（同時のログインで二重に入れない。10 分たっても終わらなければ取り直せる）
create or replace function m2o_demo_claim_seed(p_tenant text)
  returns boolean
  language sql security definer set search_path = pg_catalog, ops as $$
  with u as (
    update ops.demo_guests set seeding_at = now()
     where tenant_id = p_tenant and seeded_at is null and (seeding_at is null or seeding_at < now() - interval '10 minutes')
    returning 1
  ) select exists (select 1 from u);
$$;

create or replace function m2o_demo_mark_seeded(p_tenant text)
  returns void
  language sql security definer set search_path = pg_catalog, ops as $$
  update ops.demo_guests set seeded_at = now() where tenant_id = p_tenant and seeded_at is null;
$$;

-- アプリ: ログイン状態（Cookie のハッシュ）から体験用の会社を決める（使える状態の体験のときだけ）
create or replace function m2o_demo_session_tenant(p_session text)
  returns text
  language sql stable security definer set search_path = pg_catalog, public, ops as $$
  select s.tenant_id from sessions s
    join ops.demo_guests g on g.tenant_id = s.tenant_id and g.user_id = s.user_id
   where s.id = p_session and s.tenant_id like 'd-%' and s.revoked_at is null and s.expires_at > now()
     and g.ended_at is null and g.deleted_at is null and g.expires_at > now() and g.seeded_at is not null;
$$;

-- アプリ: 体験の様子（AI の上限と期間・規約への同意）
create or replace function m2o_demo_trial(p_tenant text)
  returns table (ai_cap_jpy numeric, started_at timestamptz, expires_at timestamptz, terms_accepted_at timestamptz)
  language sql stable security definer set search_path = pg_catalog, ops as $$
  select g.ai_cap_jpy, g.created_at, g.expires_at, g.terms_accepted_at from ops.demo_guests g where g.tenant_id = p_tenant and g.deleted_at is null;
$$;

create or replace function m2o_demo_accept_terms(p_tenant text)
  returns void
  language sql security definer set search_path = pg_catalog, ops as $$
  update ops.demo_guests set terms_accepted_at = coalesce(terms_accepted_at, now()) where tenant_id = p_tenant and deleted_at is null;
$$;

-- ワーカー: 期限が来た体験の会社を消し（返すのは消した会社。中のファイルの置き場はワーカーが消す）、終えて 90 日たった相手の情報を消す
create or replace function m2o_demo_purge_due()
  returns setof text
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare r record;
begin
  update ops.demo_guests set company = '', contact = '', email = '', contact_purged_at = now()
   where contact_purged_at is null and coalesce(ended_at, expires_at) < now() - interval '90 days';
  for r in select g.tenant_id from ops.demo_guests g where g.deleted_at is null and (g.ended_at is not null or g.expires_at <= now()) loop
    if m2o_demo_purge(r.tenant_id) then return next r.tenant_id; end if;
    -- 会社がすでに無い（手で消したなど）ときも、消した印を付ける
    update ops.demo_guests set deleted_at = now() where tenant_id = r.tenant_id and deleted_at is null;
  end loop;
end $$;

-- 運営が早く終えた体験は、ワーカーより先に消してあるので、置き場の名前だけをワーカーに渡す
create or replace function m2o_demo_storage_due(p_since timestamptz)
  returns setof text
  language sql stable security definer set search_path = pg_catalog, ops as $$
  select g.tenant_id from ops.demo_guests g where g.deleted_at >= p_since;
$$;

revoke all on function m2o_demo_login_lookup(text) from public;
revoke all on function m2o_demo_login_result(text, boolean) from public;
revoke all on function m2o_demo_claim_seed(text) from public;
revoke all on function m2o_demo_mark_seeded(text) from public;
revoke all on function m2o_demo_session_tenant(text) from public;
revoke all on function m2o_demo_trial(text) from public;
revoke all on function m2o_demo_accept_terms(text) from public;
revoke all on function m2o_demo_purge_due() from public;
revoke all on function m2o_demo_storage_due(timestamptz) from public;
grant execute on function m2o_demo_login_lookup(text) to m2office_app;
grant execute on function m2o_demo_login_result(text, boolean) to m2office_app;
grant execute on function m2o_demo_claim_seed(text) to m2office_app;
grant execute on function m2o_demo_mark_seeded(text) to m2office_app;
grant execute on function m2o_demo_session_tenant(text) to m2office_app;
grant execute on function m2o_demo_trial(text) to m2office_app;
grant execute on function m2o_demo_accept_terms(text) to m2office_app;
grant execute on function m2o_demo_purge_due() to m2office_app;
grant execute on function m2o_demo_storage_due(timestamptz) to m2office_app;

-- 体験用の会社は、会社一覧と毎晩の数に入れない（移行 111・112 の関数に、印の条件を足して作り直す）
create or replace function ops.tenant_overview()
  returns table (
    id text, subdomain text, name text, workspace_domain text, status text, created_at timestamptz,
    users_active integer, users_invited integer, users_30d integer, last_used_at timestamptz,
    runs_today integer, runs_30d integer, runs_failed_30d integer, conversations_30d integer,
    ai_cost_month numeric, files_bytes bigint, extensions integer, google_connections integer
  )
  language sql stable security definer set search_path = pg_catalog, public as $$
  with b as (
    select (date_trunc('day', now() at time zone 'Asia/Tokyo')) at time zone 'Asia/Tokyo' as today,
           (date_trunc('month', now() at time zone 'Asia/Tokyo')) at time zone 'Asia/Tokyo' as month,
           now() - interval '30 days' as d30
  )
  select t.id, t.subdomain, t.name, t.workspace_domain, t.status, t.created_at,
    (select count(*)::int from users u where u.tenant_id = t.id and u.status = 'active'),
    (select count(*)::int from users u where u.tenant_id = t.id and u.status = 'active'
       and not exists (select 1 from sessions s where s.tenant_id = t.id and s.user_id = u.id)),
    (select count(distinct s.user_id)::int from sessions s where s.tenant_id = t.id and s.last_seen_at >= b.d30),
    (select max(s.last_seen_at) from sessions s where s.tenant_id = t.id),
    (select count(*)::int from runs r where r.tenant_id = t.id and r.started_at >= b.today),
    (select count(*)::int from runs r where r.tenant_id = t.id and r.started_at >= b.d30),
    (select count(*)::int from runs r where r.tenant_id = t.id and r.started_at >= b.d30 and r.status = 'failed'),
    (select count(*)::int from conversations c where c.tenant_id = t.id and c.created_at >= b.d30),
    (select coalesce(sum(a.cost_jpy), 0) from ai_usage a where a.tenant_id = t.id and a.at >= b.month),
    (select coalesce(sum(f.size), 0)::bigint from files f where f.tenant_id = t.id),
    (select count(*)::int from tenant_extensions e where e.tenant_id = t.id),
    (select count(*)::int from user_google_connections g where g.tenant_id = t.id)
  from tenants t, b
  where t.kind = 'customer'
  order by t.created_at;
$$;

create or replace function m2o_ops_record_daily(p_day date)
  returns integer
  language sql security definer set search_path = pg_catalog, public, ops as $$
  with b as (
    select p_day::timestamp at time zone 'Asia/Tokyo' as s, (p_day + 1)::timestamp at time zone 'Asia/Tokyo' as e
  ), ins as (
    insert into ops.tenant_daily (tenant_id, day, users_active, users_day, runs, runs_failed, conversations, ai_cost, ai_calls, files_bytes, recorded_at)
    select t.id, p_day,
      (select count(*) from users u where u.tenant_id = t.id and u.status = 'active'),
      (select count(distinct s.user_id) from sessions s where s.tenant_id = t.id and s.last_seen_at >= b.s and s.last_seen_at < b.e),
      (select count(*) from runs r where r.tenant_id = t.id and r.started_at >= b.s and r.started_at < b.e),
      (select count(*) from runs r where r.tenant_id = t.id and r.started_at >= b.s and r.started_at < b.e and r.status = 'failed'),
      (select count(*) from conversations c where c.tenant_id = t.id and c.created_at >= b.s and c.created_at < b.e),
      (select coalesce(sum(a.cost_jpy), 0) from ai_usage a where a.tenant_id = t.id and a.at >= b.s and a.at < b.e),
      (select count(*) from ai_usage a where a.tenant_id = t.id and a.at >= b.s and a.at < b.e),
      (select coalesce(sum(f.size), 0) from files f where f.tenant_id = t.id),
      now()
    from tenants t, b
    where t.kind = 'customer'
    on conflict (tenant_id, day) do update set
      users_active = excluded.users_active, users_day = excluded.users_day, runs = excluded.runs, runs_failed = excluded.runs_failed,
      conversations = excluded.conversations, ai_cost = excluded.ai_cost, ai_calls = excluded.ai_calls, files_bytes = excluded.files_bytes,
      recorded_at = excluded.recorded_at
    returning 1
  )
  select count(*)::int from ins;
$$;

-- 新しい会社に `demo` の名前を払い出さない（体験版の入口。移行 111 の関数の予約語に足して作り直す）
create or replace function ops.create_tenant(p_subdomain text, p_name text, p_domain text, p_admin text, p_status text, p_operator text)
  returns text
  language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_tenant text := 't-' || p_subdomain;
  v_user text := 'u-' || p_subdomain || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 8);
begin
  if p_subdomain !~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' or p_subdomain = any (array['www','api','app','admin','ops','signup','demo','mail','docs','status','help','localhost']) then
    raise exception 'subdomain_invalid';
  end if;
  if p_status not in ('trial', 'active') then raise exception 'status_invalid'; end if;
  if split_part(p_admin, '@', 2) <> p_domain then raise exception 'admin_domain'; end if;
  if exists (select 1 from tenants where subdomain = p_subdomain or id = v_tenant) then raise exception 'subdomain_taken'; end if;
  if exists (select 1 from tenants where workspace_domain = p_domain) then raise exception 'domain_taken'; end if;
  insert into tenants (id, subdomain, name, workspace_domain, status) values (v_tenant, p_subdomain, p_name, p_domain, p_status);
  insert into users (id, tenant_id, email, display_name, roles)
    values (v_user, v_tenant, p_admin, split_part(p_admin, '@', 1), array['admin', 'approver', 'member']);
  insert into audit_events (id, tenant_id, actor_type, actor_id, action, target_type, target_id, detail, occurred_at)
    values (gen_random_uuid()::text, v_tenant, 'system', 'ops:' || p_operator, 'tenant.create', 'tenant', v_tenant,
            jsonb_build_object('subdomain', p_subdomain, 'domain', p_domain, 'admin', p_admin, 'status', p_status), now());
  return v_tenant;
end;
$$;
