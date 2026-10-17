-- 障害・計画停止の知らせと、月ごとの稼働の報告（仕様書 第16.11.3節 G-9。第 0.390.0 版）
--
-- 運営者がマスター管理画面で障害（止まった）・一部の不具合（遅い・一部が使えない）・計画停止を起こし、経過を書き、終える。
-- 起こした・経過を書いた・終えたときに、対象の会社の管理者に知らせる（種類 service）。会社の管理者ページは、その会社に関わるものだけを読み、
-- 月ごとの稼働率（計画停止を除く）を出す。表は運営の側（ops）に置き、決めた関数だけで触る（ほかの会社の ID を顧客の側に渡さない）。
create table if not exists ops.service_incidents (
  id            text primary key,
  title         text not null,
  impact        text not null check (impact in ('down', 'degraded', 'maintenance')),
  -- 対象の会社。null ならすべての会社
  tenant_ids    text[],
  body          text not null default '',
  -- 経過（{at, body, ended}）。知らせた文をそのまま残す
  updates       jsonb not null default '[]',
  started_at    timestamptz not null,
  ended_at      timestamptz,
  created_by    text not null,
  created_label text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists service_incidents_started on ops.service_incidents (started_at desc);

-- 対象の会社の管理者に知らせ、会社の監査ログに残す（利用を止めた会社・消した会社には知らせない）
create or replace function ops._incident_notice(p_incident text, p_title text, p_body text, p_action text, p_operator text)
  returns integer
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare v_tenants text[]; v_n integer := 0; t text;
begin
  select tenant_ids into v_tenants from ops.service_incidents where id = p_incident;
  for t in select id from tenants where status in ('trial', 'active', 'suspended') and (v_tenants is null or id = any (v_tenants)) loop
    perform ops._tenant_notice(t, p_action, 'ops:' || p_operator, p_title, p_body, jsonb_build_object('incident', p_incident));
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke all on function ops._incident_notice(text, text, text, text, text) from public;

-- 起こす。知らせた会社の数を返す
create or replace function ops.open_incident(p_title text, p_impact text, p_body text, p_tenants text[], p_started timestamptz, p_operator text, p_label text)
  returns table (id text, notified integer)
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare v_id text := gen_random_uuid()::text; v_head text;
begin
  if coalesce(btrim(p_title), '') = '' then raise exception 'reason_required'; end if;
  if p_impact not in ('down', 'degraded', 'maintenance') then raise exception 'kind_invalid'; end if;
  if p_tenants is not null and cardinality(p_tenants) = 0 then raise exception 'not_found'; end if;
  insert into ops.service_incidents (id, title, impact, tenant_ids, body, updates, started_at, created_by, created_label)
    values (v_id, left(p_title, 100), p_impact, p_tenants, left(coalesce(p_body, ''), 2000),
            jsonb_build_array(jsonb_build_object('at', now(), 'body', left(coalesce(p_body, ''), 2000), 'ended', false)),
            coalesce(p_started, now()), p_operator, coalesce(p_label, ''));
  v_head := case p_impact when 'down' then '障害のお知らせ: ' when 'degraded' then '不具合のお知らせ: ' else '計画停止のお知らせ: ' end;
  return query select v_id, ops._incident_notice(v_id, v_head || left(p_title, 100), coalesce(p_body, ''), 'service.incident', p_operator);
end;
$$;

-- 経過を書く（終えていないものだけ）
create or replace function ops.update_incident(p_id text, p_body text, p_operator text)
  returns integer
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare i ops.service_incidents%rowtype;
begin
  if coalesce(btrim(p_body), '') = '' then raise exception 'reason_required'; end if;
  select * into i from ops.service_incidents where id = p_id for update;
  if i.id is null then raise exception 'not_found'; end if;
  if i.ended_at is not null then raise exception 'not_pending'; end if;
  update ops.service_incidents set body = left(p_body, 2000), updated_at = now(),
    updates = updates || jsonb_build_array(jsonb_build_object('at', now(), 'body', left(p_body, 2000), 'ended', false)) where id = p_id;
  return ops._incident_notice(p_id, '経過のお知らせ: ' || i.title, p_body, 'service.incident_update', p_operator);
end;
$$;

-- 終える（復旧・計画停止の終わり）。終わりの時刻は始まりより後
create or replace function ops.close_incident(p_id text, p_ended timestamptz, p_body text, p_operator text)
  returns integer
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare i ops.service_incidents%rowtype; v_end timestamptz := coalesce(p_ended, now()); v_body text;
begin
  select * into i from ops.service_incidents where id = p_id for update;
  if i.id is null then raise exception 'not_found'; end if;
  if i.ended_at is not null then raise exception 'not_pending'; end if;
  if v_end < i.started_at or v_end > now() + interval '1 minute' then raise exception 'time_invalid'; end if;
  v_body := coalesce(nullif(btrim(p_body), ''), case when i.impact = 'maintenance' then '計画停止を終えました。' else '復旧しました。' end);
  update ops.service_incidents set ended_at = v_end, body = left(v_body, 2000), updated_at = now(),
    updates = updates || jsonb_build_array(jsonb_build_object('at', now(), 'body', left(v_body, 2000), 'ended', true)) where id = p_id;
  return ops._incident_notice(p_id, case when i.impact = 'maintenance' then '計画停止を終えました: ' else '復旧のお知らせ: ' end || i.title, v_body, 'service.incident_close', p_operator);
end;
$$;

-- 運営の一覧（新しい順）
create or replace function ops.list_incidents(p_limit integer)
  returns setof ops.service_incidents
  language sql stable security definer set search_path = pg_catalog, ops as $$
  select * from ops.service_incidents order by started_at desc limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

-- 顧客の側: その会社に関わるもので、期間に重なるもの（対象の会社の一覧は渡さない）
create or replace function m2o_service_incidents(p_tenant text, p_from timestamptz, p_to timestamptz)
  returns table (id text, title text, impact text, body text, updates jsonb, started_at timestamptz, ended_at timestamptz)
  language sql stable security definer set search_path = pg_catalog, ops as $$
  select id, title, impact, body, updates, started_at, ended_at from ops.service_incidents
   where (tenant_ids is null or p_tenant = any (tenant_ids)) and started_at < p_to and (ended_at is null or ended_at > p_from)
   order by started_at desc;
$$;

revoke all on function ops.open_incident(text, text, text, text[], timestamptz, text, text) from public;
revoke all on function ops.update_incident(text, text, text) from public;
revoke all on function ops.close_incident(text, timestamptz, text, text) from public;
revoke all on function ops.list_incidents(integer) from public;
revoke all on function m2o_service_incidents(text, timestamptz, timestamptz) from public;
grant execute on function ops.open_incident(text, text, text, text[], timestamptz, text, text) to m2office_ops;
grant execute on function ops.update_incident(text, text, text) to m2office_ops;
grant execute on function ops.close_incident(text, timestamptz, text, text) to m2office_ops;
grant execute on function ops.list_incidents(integer) to m2office_ops;
grant execute on function m2o_service_incidents(text, timestamptz, timestamptz) to m2office_app;
