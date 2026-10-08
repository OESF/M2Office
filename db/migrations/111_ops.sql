-- マスター管理画面の段 1（仕様書 第23.8.15節、ADR-0078。第 0.308.0 版）
--
-- 運営の API は、顧客向けの API と別のプロセスで、専用のロール m2office_ops で接続する（Q-212）。
-- このロールは ops スキーマの表だけを触り、顧客の表（public）の権限を持たない。
-- 会社の数を数える・会社を作る・状態を変えるは、所有者の権限で動く決めた関数（ops.*）だけで行い、件数・金額・状態だけを返す。
--
-- ロールは NOLOGIN で作る。ログインと合言葉は scripts/migrate.mjs が OPS_DATABASE_URL から付ける（合言葉を SQL に書かないため。
-- 本番で OPS_DATABASE_URL が無ければログインできないまま。ローカルの形には運営の画面を入れない）。

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'm2office_ops') then
    create role m2office_ops nologin nosuperuser nobypassrls;
  end if;
end $$;

-- public の関数は、PostgreSQL の既定では誰でも呼べる。所有者の権限で動く関数（在庫の公開・コラムのページなど）には
-- テナントを横断して読むものがあるため、呼べるのをアプリのロールだけにする（運営のロールから届かないように）
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and has_function_privilege('public', p.oid, 'execute')
  loop
    execute format('grant execute on routine %s to m2office_app', f.sig);
    execute format('revoke execute on routine %s from public', f.sig);
  end loop;
end $$;
-- これから作る関数も同じ扱いにする（所有者が作る関数は誰でも呼べないようにし、public のものはアプリのロールに渡す）
alter default privileges revoke execute on functions from public;
alter default privileges in schema public grant execute on functions to m2office_app;

create schema if not exists ops;
revoke all on schema ops from public;
grant usage on schema ops to m2office_ops;

-- 運営者（顧客の会社の利用者とは別。第23.8.9節）
create table if not exists ops.operators (
  id             text primary key,
  email          text not null unique,
  display_name   text not null,
  -- admin（運営管理者）・support（サポート）・monitor（監視）
  role           text not null check (role in ('admin', 'support', 'monitor')),
  status         text not null default 'active' check (status in ('active', 'disabled')),
  created_by     text not null,
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz
);

-- 運営のログイン状態（Cookie の値の SHA-256 だけを持つ）
create table if not exists ops.sessions (
  id           text primary key,
  operator_id  text not null references ops.operators(id) on delete cascade,
  csrf_token   text not null,
  provider     text not null,
  user_agent   text,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);
create index if not exists ops_sessions_operator on ops.sessions (operator_id);

-- 運営の操作の記録（追記だけ。第23.8.10節）
create table if not exists ops.audit (
  id           text primary key,
  operator_id  text not null,
  action       text not null,
  target_type  text not null,
  target_id    text not null,
  detail       jsonb not null default '{}'::jsonb,
  occurred_at  timestamptz not null default now()
);
create index if not exists ops_audit_at on ops.audit (occurred_at desc);

-- ローカルの形の機械（稼働の知らせを送る。第8.6.8節）。受け口の鍵は SHA-256 だけを持つ
create table if not exists ops.machines (
  id            text primary key,
  -- 運営が付けた呼び名（会社の名前を入れてもよいのは運営の側だけ）
  name          text not null,
  token_hash    text not null unique,
  created_by    text not null,
  created_at    timestamptz not null default now(),
  last_at       timestamptz,
  last_payload  jsonb
);

grant select, insert, update on ops.operators, ops.sessions, ops.machines to m2office_ops;
grant delete on ops.machines to m2office_ops;
grant select, insert on ops.audit to m2office_ops;

-- 会社ごとの数（件数・金額・状態だけ。業務の中身と人の名前は返さない。第23.8.15節）
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
  order by t.created_at;
$$;

-- 会社と最初の管理者を作る（第23.8.15節「会社を作る」）。サブドメインの規則と予約語は API でも確かめるが、ここでも確かめる
create or replace function ops.create_tenant(p_subdomain text, p_name text, p_domain text, p_admin text, p_status text, p_operator text)
  returns text
  language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_tenant text := 't-' || p_subdomain;
  v_user text := 'u-' || p_subdomain || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 8);
begin
  if p_subdomain !~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' or p_subdomain = any (array['www','api','app','admin','ops','mail','docs','status','help','localhost']) then
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

-- 試用と稼働の切り替え（段 1 はこの 2 つの間だけ。停止・再開・解約は段 2 で 2 人の承認）
create or replace function ops.set_tenant_status(p_tenant text, p_status text, p_operator text)
  returns text
  language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_from text;
begin
  if p_status not in ('trial', 'active') then raise exception 'status_invalid'; end if;
  select status into v_from from tenants where id = p_tenant for update;
  if v_from is null then raise exception 'not_found'; end if;
  if v_from not in ('trial', 'active') then raise exception 'status_locked'; end if;
  if v_from = p_status then return v_from; end if;
  update tenants set status = p_status where id = p_tenant;
  insert into audit_events (id, tenant_id, actor_type, actor_id, action, target_type, target_id, detail, occurred_at)
    values (gen_random_uuid()::text, p_tenant, 'system', 'ops:' || p_operator, 'tenant.status', 'tenant', p_tenant,
            jsonb_build_object('from', v_from, 'to', p_status), now());
  return v_from;
end;
$$;

revoke all on function ops.tenant_overview() from public;
revoke all on function ops.create_tenant(text, text, text, text, text, text) from public;
revoke all on function ops.set_tenant_status(text, text, text) from public;
grant execute on function ops.tenant_overview() to m2office_ops;
grant execute on function ops.create_tenant(text, text, text, text, text, text) to m2office_ops;
grant execute on function ops.set_tenant_status(text, text, text) to m2office_ops;
