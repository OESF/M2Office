-- システムログの保管・閲覧・証拠保全（仕様書 第16.10節。第 0.370.0 版。ADR-0098）
--
-- ① system_logs: アプリが書くシステムログ。日ごとに区切った表（UTC の日）。28 日を過ぎた区切りはワーカーが捨てる。
--    アプリのロール・運営のロールは書くだけ。読むのは決まった関数だけ（アプリは本人の会社の分と会社に属さない分・運営はすべて）。
-- ② system_log_digests: 日ごとの SHA-256 を前の日の値とつなげた鎖（追記だけ）。書き換え・削除が分かるようにする。
-- ③ evidence_packages・evidence_chunks: 証拠保全の ZIP（8 MB ずつに分けて持つ）。追記だけで、保全してから 1 年は消せない。
create table if not exists system_logs (
  id          bigint generated always as identity,
  at          timestamptz not null,
  level       text not null,
  service     text not null,
  msg         text not null,
  tenant_id   text,
  user_id     text,
  request_id  text,
  run_id      text,
  fields      jsonb not null default '{}'::jsonb,
  primary key (at, id)
) partition by range (at);
create table if not exists system_logs_default partition of system_logs default;
create index if not exists system_logs_at_idx on system_logs (at desc);
create index if not exists system_logs_tenant_idx on system_logs (tenant_id, at desc);
grant insert on system_logs to m2office_app;
grant insert on system_logs to m2office_ops;

-- 区切りを作る（今日から 2 日先まで）。ワーカーが毎日と起動のときに呼ぶ
create or replace function m2o_system_logs_prepare() returns void
  language plpgsql security definer set search_path = pg_catalog, public as $$
declare d date;
begin
  for i in 0..2 loop
    d := (now() at time zone 'utc')::date + i;
    if to_regclass(format('public.system_logs_%s', to_char(d, 'YYYYMMDD'))) is null then
      -- 既定の区切りに入っていた同じ日の行を、新しい区切りへ移す（重なると作れないため）
      execute format('create table public.system_logs_%s (like public.system_logs including defaults)', to_char(d, 'YYYYMMDD'));
      execute format('insert into public.system_logs_%s overriding system value select * from public.system_logs_default where at >= %L and at < %L', to_char(d, 'YYYYMMDD'), d::timestamptz, (d + 1)::timestamptz);
      execute format('delete from public.system_logs_default where at >= %L and at < %L', d::timestamptz, (d + 1)::timestamptz);
      execute format('alter table public.system_logs attach partition public.system_logs_%s for values from (%L) to (%L)', to_char(d, 'YYYYMMDD'), (d::text || ' 00:00:00+00'), ((d + 1)::text || ' 00:00:00+00'));
    end if;
  end loop;
end $$;

-- 入れ替え: keep_days を過ぎた日の区切りを捨て、既定の区切りの古い行も消す。捨てた日の数を返す
create or replace function m2o_system_logs_rotate(p_keep_days integer) returns integer
  language plpgsql security definer set search_path = pg_catalog, public as $$
declare r record; cutoff date := (now() at time zone 'utc')::date - p_keep_days; n integer := 0;
begin
  for r in
    select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid join pg_class p on p.oid = i.inhparent
     where p.relname = 'system_logs' and c.relname ~ '^system_logs_[0-9]{8}$'
  loop
    if to_date(substr(r.relname, 13), 'YYYYMMDD') < cutoff then
      execute format('drop table public.%I', r.relname);
      n := n + 1;
    end if;
  end loop;
  delete from system_logs_default where at < cutoff::timestamptz;
  return n;
end $$;

-- 読む（アプリのロール）: 本人の会社の分と、会社に属さない仕組みの分だけ。新しい順に、before より前を limit 件
create or replace function m2o_read_system_logs(
  p_from timestamptz, p_to timestamptz, p_levels text[], p_service text, p_q text, p_request text, p_run text,
  p_before timestamptz, p_before_id bigint, p_limit integer
) returns setof system_logs
  language sql stable security definer set search_path = pg_catalog, public as $$
  select * from system_logs l
   where l.at >= p_from and l.at < p_to
     and (l.tenant_id = m2o_current_tenant() or l.tenant_id is null)
     and (p_levels is null or l.level = any(p_levels))
     and (p_service is null or l.service = p_service)
     and (p_request is null or l.request_id = p_request)
     and (p_run is null or l.run_id = p_run)
     and (p_q is null or l.msg ilike '%' || p_q || '%' or l.fields::text ilike '%' || p_q || '%')
     and (p_before is null or (l.at, l.id) < (p_before, coalesce(p_before_id, 9223372036854775807)))
   order by l.at desc, l.id desc
   limit least(greatest(p_limit, 1), 100000);
$$;

-- 日ごとの SHA-256（その日のすべての行を時刻順に。行ごとの SHA-256 をつないで作る）
create or replace function m2o_system_log_day_digest(p_day date) returns table (rows integer, sha256 text)
  language sql stable security definer set search_path = pg_catalog, public as $$
  select count(*)::int,
         encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(
           concat_ws(chr(31), l.id::text, to_char(l.at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US'), l.level, l.service, l.msg,
             coalesce(l.tenant_id, ''), coalesce(l.user_id, ''), coalesce(l.request_id, ''), coalesce(l.run_id, ''), l.fields::text), 'UTF8')), 'hex'),
           '' order by l.at, l.id), ''), 'UTF8')), 'hex')
    from system_logs l
   where l.at >= p_day::timestamptz and l.at < (p_day + 1)::timestamptz;
$$;

-- いちばん古い行の日（日ごとの値を残し始める日）
create or replace function m2o_system_logs_first_day() returns date
  language sql stable security definer set search_path = pg_catalog, public as $$
  select (min(at) at time zone 'utc')::date from system_logs;
$$;

create table if not exists system_log_digests (
  day         date primary key,
  rows        integer not null,
  sha256      text not null,
  -- 前の日の chain とこの日の sha256 をつないだ SHA-256（最初の日は sha256 だけから）
  chain       text not null,
  created_at  timestamptz not null default now()
);
grant select, insert on system_log_digests to m2office_app;

-- 証拠保全（第16.10.5節）
create table if not exists evidence_packages (
  id             text primary key,
  -- machine: ローカルの形の機械のすべて / tenant: クラウドの形の 1 社 / all: クラウドの形の全体
  scope          text not null check (scope in ('machine', 'tenant', 'all')),
  tenant_id      text,
  reason         text not null check (char_length(reason) between 1 and 300),
  -- user（会社の管理者）・operator（運営者）・system（自動）
  created_kind   text not null check (created_kind in ('user', 'operator', 'system')),
  created_by     text not null,
  range_from     timestamptz not null,
  range_to       timestamptz not null,
  status         text not null default 'pending' check (status in ('pending', 'building', 'ready', 'failed', 'deleted')),
  size           bigint,
  sha256         text,
  manifest       jsonb,
  failure        text,
  created_at     timestamptz not null default now(),
  ready_at       timestamptz,
  deleted_at     timestamptz,
  deleted_by     text,
  delete_reason  text
);
create index if not exists evidence_packages_tenant_idx on evidence_packages (tenant_id, created_at desc);
create table if not exists evidence_chunks (
  package_id  text not null references evidence_packages(id),
  seq         integer not null,
  bytes       bytea not null,
  primary key (package_id, seq)
);

alter table evidence_packages enable row level security;
drop policy if exists tenant_isolation on evidence_packages;
create policy tenant_isolation on evidence_packages using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert on evidence_packages to m2office_app;
-- 中身はアプリのロールから直接読ませない（会社を横断できてしまうため）。本人の会社のものだけを返す関数で読む
revoke all on evidence_chunks from m2office_app;
create or replace function m2o_evidence_chunk(p_id text, p_seq integer) returns bytea
  language sql stable security definer set search_path = pg_catalog, public as $$
  select c.bytes from evidence_chunks c join evidence_packages p on p.id = c.package_id
   where c.package_id = p_id and c.seq = p_seq and p.tenant_id = m2o_current_tenant() and p.status = 'ready';
$$;

-- 保全したものを書き換えさせない（作るときの状態の進みと、1 年を過ぎた後の削除だけを許す）
create or replace function m2o_evidence_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception '証拠保全したものは消せません（削除の印を付けます）'; end if;
  if old.status = 'deleted' then raise exception '削除したものは変えられません'; end if;
  if new.status = 'deleted' then
    if old.created_at > now() - interval '1 year' then raise exception '保全してから 1 年は消せません'; end if;
    if new.deleted_by is null or coalesce(new.delete_reason, '') = '' then raise exception '消すときは消す人と理由が要ります'; end if;
  elsif old.status = 'ready' then
    raise exception '保全したものは変えられません';
  end if;
  if new.id <> old.id or new.scope <> old.scope or new.tenant_id is distinct from old.tenant_id or new.reason <> old.reason
     or new.created_by <> old.created_by or new.range_from <> old.range_from or new.range_to <> old.range_to
     or new.created_at <> old.created_at or (old.sha256 is not null and new.sha256 is distinct from old.sha256) then
    raise exception '保全したものの中身は変えられません';
  end if;
  return new;
end $$;
drop trigger if exists evidence_guard on evidence_packages;
create trigger evidence_guard before update or delete on evidence_packages for each row execute function m2o_evidence_guard();

-- ワーカー: 待っている保全を 1 つ取る（会社を横断する。待ち行列の取り出しと同じ形）
create or replace function m2o_claim_evidence() returns setof evidence_packages
  language sql security definer set search_path = pg_catalog, public as $$
  update evidence_packages set status = 'building'
   where id = (select id from evidence_packages where status = 'pending' order by created_at for update skip locked limit 1)
  returning *;
$$;
-- ワーカー: ZIP を 8 MB ずつ書き、できあがったら印を付ける（失敗も）
create or replace function m2o_evidence_put_chunk(p_id text, p_seq integer, p_bytes bytea) returns void
  language sql security definer set search_path = pg_catalog, public as $$
  insert into evidence_chunks (package_id, seq, bytes)
  select p_id, p_seq, p_bytes where exists (select 1 from evidence_packages where id = p_id and status = 'building');
$$;
create or replace function m2o_evidence_finish(p_id text, p_ok boolean, p_size bigint, p_sha256 text, p_manifest jsonb, p_failure text) returns void
  language sql security definer set search_path = pg_catalog, public as $$
  update evidence_packages
     set status = case when p_ok then 'ready' else 'failed' end, size = p_size, sha256 = p_sha256, manifest = p_manifest,
         failure = p_failure, ready_at = case when p_ok then now() end
   where id = p_id and status = 'building';
  delete from evidence_chunks where package_id = p_id and not p_ok;
$$;
-- ワーカー: 保全に入れるシステムログ（会社で絞るか、全体）
create or replace function m2o_evidence_logs(p_tenant text, p_all boolean, p_from timestamptz, p_to timestamptz, p_after timestamptz, p_after_id bigint, p_limit integer)
  returns setof system_logs
  language sql stable security definer set search_path = pg_catalog, public as $$
  select * from system_logs l
   where l.at >= p_from and l.at < p_to
     and (p_all or l.tenant_id = p_tenant or (l.tenant_id is null and p_tenant is null))
     and (p_after is null or (l.at, l.id) > (p_after, coalesce(p_after_id, 0)))
   order by l.at, l.id
   limit least(greatest(p_limit, 1), 100000);
$$;
-- 会社の管理者（ローカルの形）: 1 年を過ぎた保全を消す（中身も消す）
create or replace function m2o_evidence_delete(p_id text, p_by text, p_reason text) returns boolean
  language plpgsql security definer set search_path = pg_catalog, public as $$
declare n integer;
begin
  update evidence_packages set status = 'deleted', deleted_at = now(), deleted_by = p_by, delete_reason = p_reason
   where id = p_id and tenant_id = m2o_current_tenant() and status in ('ready', 'failed');
  get diagnostics n = row_count;
  if n = 0 then return false; end if;
  delete from evidence_chunks where package_id = p_id;
  return true;
end $$;

-- 運営（クラウドの形）
create or replace function ops.read_system_logs(
  p_tenant text, p_system boolean, p_from timestamptz, p_to timestamptz, p_levels text[], p_service text, p_q text, p_request text, p_run text,
  p_before timestamptz, p_before_id bigint, p_limit integer
) returns setof system_logs
  language sql stable security definer set search_path = pg_catalog, public as $$
  select * from system_logs l
   where l.at >= p_from and l.at < p_to
     and (p_tenant is null or l.tenant_id = p_tenant)
     and (not p_system or l.tenant_id is null)
     and (p_levels is null or l.level = any(p_levels))
     and (p_service is null or l.service = p_service)
     and (p_request is null or l.request_id = p_request)
     and (p_run is null or l.run_id = p_run)
     and (p_q is null or l.msg ilike '%' || p_q || '%' or l.fields::text ilike '%' || p_q || '%')
     and (p_before is null or (l.at, l.id) < (p_before, coalesce(p_before_id, 9223372036854775807)))
   order by l.at desc, l.id desc
   limit least(greatest(p_limit, 1), 100000);
$$;
create or replace function ops.system_log_digests(p_from date, p_to date)
  returns table (day date, rows integer, sha256 text, chain text, now_rows integer, now_sha256 text)
  language sql stable security definer set search_path = pg_catalog, public as $$
  select d.day, d.rows, d.sha256, d.chain, x.rows, x.sha256
    from system_log_digests d, lateral m2o_system_log_day_digest(d.day) x
   where d.day >= p_from and d.day <= p_to order by d.day;
$$;
create or replace function ops.request_evidence(p_id text, p_tenant text, p_reason text, p_from timestamptz, p_to timestamptz, p_operator text)
  returns void language sql security definer set search_path = pg_catalog, public as $$
  insert into evidence_packages (id, scope, tenant_id, reason, created_kind, created_by, range_from, range_to)
  values (p_id, case when p_tenant is null then 'all' else 'tenant' end, p_tenant, p_reason, 'operator', p_operator, p_from, p_to);
$$;
create or replace function ops.list_evidence()
  returns table (id text, scope text, tenant_id text, reason text, created_kind text, created_by text, range_from timestamptz, range_to timestamptz,
                 status text, size bigint, sha256 text, failure text, created_at timestamptz, ready_at timestamptz, deleted_at timestamptz)
  language sql stable security definer set search_path = pg_catalog, public as $$
  select id, scope, tenant_id, reason, created_kind, created_by, range_from, range_to, status, size, sha256, failure, created_at, ready_at, deleted_at
    from evidence_packages order by created_at desc limit 500;
$$;
create or replace function ops.evidence_chunk(p_id text, p_seq integer) returns bytea
  language sql stable security definer set search_path = pg_catalog, public as $$
  select bytes from evidence_chunks where package_id = p_id and seq = p_seq;
$$;
create or replace function ops.delete_evidence(p_id text, p_operator text, p_reason text) returns boolean
  language plpgsql security definer set search_path = pg_catalog, public as $$
declare n integer;
begin
  update evidence_packages set status = 'deleted', deleted_at = now(), deleted_by = p_operator, delete_reason = p_reason
   where id = p_id and status in ('ready', 'failed');
  get diagnostics n = row_count;
  if n = 0 then return false; end if;
  delete from evidence_chunks where package_id = p_id;
  return true;
end $$;
-- 運営の画面の会社の詳細に、運営がシステムログを見た日時を出すため、運営の操作履歴を会社で引ける形にする（ops.audit をそのまま使う）

do $$
declare f text;
begin
  foreach f in array array[
    'ops.read_system_logs(text, boolean, timestamptz, timestamptz, text[], text, text, text, text, timestamptz, bigint, integer)',
    'ops.system_log_digests(date, date)', 'ops.request_evidence(text, text, text, timestamptz, timestamptz, text)', 'ops.list_evidence()',
    'ops.evidence_chunk(text, integer)', 'ops.delete_evidence(text, text, text)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to m2office_ops', f);
  end loop;
  foreach f in array array[
    'm2o_system_logs_prepare()', 'm2o_system_logs_rotate(integer)', 'm2o_system_logs_first_day()',
    'm2o_read_system_logs(timestamptz, timestamptz, text[], text, text, text, text, timestamptz, bigint, integer)',
    'm2o_system_log_day_digest(date)', 'm2o_claim_evidence()', 'm2o_evidence_put_chunk(text, integer, bytea)',
    'm2o_evidence_finish(text, boolean, bigint, text, jsonb, text)',
    'm2o_evidence_logs(text, boolean, timestamptz, timestamptz, timestamptz, bigint, integer)', 'm2o_evidence_delete(text, text, text)', 'm2o_evidence_chunk(text, integer)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to m2office_app', f);
  end loop;
end $$;
select m2o_system_logs_prepare();
