-- 代理アクセス（仕様書 第23.6.1節。第 0.312.0 版）
--
-- 運営者が申請し、会社の管理者の誰か 1 人が期限を選んで許すと、申請した運営者だけが閲覧だけのログイン状態で会社の画面に入れる。
-- 申請と許可は proxy_grants、閲覧のログイン状態は proxy_sessions（どちらも会社ごとの行レベルセキュリティ。顧客向けの API が読む）。
-- 運営の側は決めた関数（ops.*）だけで触る。閲覧のたびに会社の監査ログに残し（proxy.view）、終わったら会社の管理者に知らせる。

create table if not exists proxy_grants (
  id                 text primary key,
  tenant_id          text not null references tenants(id) on delete cascade,
  operator_id        text not null,
  -- 会社の管理者に見せる、申請した運営者（メールアドレス）
  operator_label     text not null,
  -- admin（管理者ページ）・runs（加えて業務の結果）
  scope              text not null check (scope in ('admin', 'runs')),
  reason             text not null,
  -- requested（許すか待ち）・approved（許した）・denied（断った）・revoked（切った）・withdrawn（取り下げた）・expired（期限で切れた）
  state              text not null check (state in ('requested', 'approved', 'denied', 'revoked', 'withdrawn', 'expired')),
  requested_at       timestamptz not null default now(),
  decided_by         text,
  decided_at         timestamptz,
  hours              integer,
  expires_at         timestamptz,
  -- 入るための 1 回だけの引換券（SHA-256）と期限
  ticket_hash        text,
  ticket_expires_at  timestamptz,
  ended_at           timestamptz,
  -- 終わったあとの知らせを届けた時刻
  notified_at        timestamptz
);
create index if not exists proxy_grants_tenant on proxy_grants (tenant_id, requested_at desc);

create table if not exists proxy_sessions (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  grant_id    text not null references proxy_grants(id) on delete cascade,
  csrf_token  text not null,
  created_at  timestamptz not null default now()
);

alter table proxy_grants enable row level security;
drop policy if exists tenant_isolation on proxy_grants;
create policy tenant_isolation on proxy_grants using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
alter table proxy_sessions enable row level security;
drop policy if exists tenant_isolation on proxy_sessions;
create policy tenant_isolation on proxy_sessions using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, update on proxy_grants to m2office_app;
grant select, insert, delete on proxy_sessions to m2office_app;

-- 会社の管理者への、サポートの閲覧の知らせ（種類 support。押すと管理者ページの「サポートの閲覧」を開く）
create or replace function ops._support_notice(p_tenant text, p_title text, p_body text)
  returns void
  language sql security definer set search_path = pg_catalog, public as $$
  insert into notifications (id, tenant_id, user_id, kind, title, body, created_at)
    select gen_random_uuid()::text, p_tenant, u.id, 'support', p_title, p_body, now()
      from users u where u.tenant_id = p_tenant and u.status = 'active' and 'admin' = any (u.roles);
$$;
revoke all on function ops._support_notice(text, text, text) from public;

-- 申請する（運営管理者かサポート。API で確かめる）。会社の管理者全員に知らせる
create or replace function ops.request_proxy(p_tenant text, p_scope text, p_reason text, p_operator text, p_label text)
  returns text
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare v_id text := gen_random_uuid()::text; v_status text;
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  if p_scope not in ('admin', 'runs') then raise exception 'kind_invalid'; end if;
  select status into v_status from tenants where id = p_tenant;
  if v_status is null then raise exception 'not_found'; end if;
  if v_status in ('locked', 'cancelled') then raise exception 'status_locked'; end if;
  if exists (select 1 from proxy_grants where tenant_id = p_tenant and operator_id = p_operator and (state = 'requested' or (state = 'approved' and expires_at > now()))) then
    raise exception 'already_requested';
  end if;
  insert into proxy_grants (id, tenant_id, operator_id, operator_label, scope, reason, state) values (v_id, p_tenant, p_operator, p_label, p_scope, p_reason, 'requested');
  perform ops._support_notice(p_tenant, 'サポートからの閲覧の申請',
    '運営のサポート（' || p_label || '）が、' || case when p_scope = 'runs' then '管理者ページと、許した方が依頼した業務の結果' else '管理者ページ' end ||
    'を見ることを申し出ています。理由: ' || left(p_reason, 200) || '。管理者ページの「サポートの閲覧」で、許すか断ってください。');
  perform ops._tenant_notice(p_tenant, 'proxy.request', 'ops:' || p_operator, '', '', jsonb_build_object('grant', v_id, 'scope', p_scope, 'operator', p_label));
  return v_id;
end;
$$;

-- 入るための 1 回だけの引換券を記す（許された申請を、申請した運営者だけが）。2 分で切れる。
-- 引換券そのものは運営の API が作り、ここには SHA-256 だけを渡す（値はデータベースに残さない）
drop function if exists ops.proxy_ticket(text, text);
create or replace function ops.proxy_ticket(p_grant text, p_operator text, p_ticket_hash text)
  returns text
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare g proxy_grants%rowtype; v_sub text;
begin
  select * into g from proxy_grants where id = p_grant for update;
  if g.id is null then raise exception 'not_found'; end if;
  if g.operator_id <> p_operator then raise exception 'same_operator'; end if;
  if g.state <> 'approved' or g.expires_at <= now() then raise exception 'not_pending'; end if;
  update proxy_grants set ticket_hash = p_ticket_hash, ticket_expires_at = now() + interval '2 minutes' where id = p_grant;
  select t.subdomain into v_sub from tenants t where t.id = g.tenant_id;
  return v_sub;
end;
$$;

-- 申請を取り下げるか、許された閲覧を運営者の側から終える
create or replace function ops.end_proxy(p_grant text, p_operator text)
  returns void
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare g proxy_grants%rowtype;
begin
  select * into g from proxy_grants where id = p_grant for update;
  if g.id is null then raise exception 'not_found'; end if;
  if g.state = 'requested' then
    update proxy_grants set state = 'withdrawn', ended_at = now(), notified_at = now() where id = p_grant;
  elsif g.state = 'approved' then
    update proxy_grants set state = 'revoked', ended_at = now(), ticket_hash = null where id = p_grant;
  else
    raise exception 'not_pending';
  end if;
  delete from proxy_sessions where grant_id = p_grant;
  perform ops._tenant_notice(g.tenant_id, 'proxy.end', 'ops:' || p_operator, '', '', jsonb_build_object('grant', g.id));
end;
$$;

-- 申請の一覧（運営の画面。会社を絞るか、すべて）
create or replace function ops.list_proxy(p_tenant text)
  returns table (id text, tenant_id text, tenant_name text, operator_id text, operator_label text, scope text, reason text, state text,
                 requested_at timestamptz, decided_at timestamptz, hours integer, expires_at timestamptz, ended_at timestamptz, views bigint)
  language sql stable security definer set search_path = pg_catalog, public as $$
  select g.id, g.tenant_id, t.name, g.operator_id, g.operator_label, g.scope, g.reason,
         case when g.state = 'approved' and g.expires_at <= now() then 'expired' else g.state end,
         g.requested_at, g.decided_at, g.hours, g.expires_at, g.ended_at,
         (select count(*) from audit_events e where e.tenant_id = g.tenant_id and e.action = 'proxy.view' and e.detail->>'grant' = g.id)
    from proxy_grants g join tenants t on t.id = g.tenant_id
   where p_tenant is null or g.tenant_id = p_tenant
   order by g.requested_at desc limit 200;
$$;

-- 期限が来たか切られた閲覧の、終わったあとの知らせ（ワーカーがアプリのロールで 1 分ごとに呼ぶ）
create or replace function m2o_proxy_sweep()
  returns integer
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare g record; n integer := 0; v_views bigint;
begin
  for g in select * from proxy_grants
            where notified_at is null and ((state = 'approved' and expires_at <= now()) or state = 'revoked') for update skip locked loop
    select count(*) into v_views from audit_events e where e.tenant_id = g.tenant_id and e.action = 'proxy.view' and e.detail->>'grant' = g.id;
    update proxy_grants set state = case when state = 'approved' then 'expired' else state end, ended_at = coalesce(ended_at, now()),
           notified_at = now(), ticket_hash = null where id = g.id;
    delete from proxy_sessions where grant_id = g.id;
    perform ops._support_notice(g.tenant_id, 'サポートの閲覧が終わりました',
      '運営のサポート（' || g.operator_label || '）の閲覧が終わりました。閲覧した回数: ' || v_views || ' 回。見た画面は監査ログで確かめられます。');
    perform ops._tenant_notice(g.tenant_id, 'proxy.ended', 'ops:' || g.operator_id, '', '', jsonb_build_object('grant', g.id, 'views', v_views));
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function ops.request_proxy(text, text, text, text, text) from public;
revoke all on function ops.proxy_ticket(text, text, text) from public;
revoke all on function ops.end_proxy(text, text) from public;
revoke all on function ops.list_proxy(text) from public;
grant execute on function ops.request_proxy(text, text, text, text, text) to m2office_ops;
grant execute on function ops.proxy_ticket(text, text, text) to m2office_ops;
grant execute on function ops.end_proxy(text, text) to m2office_ops;
grant execute on function ops.list_proxy(text) to m2office_ops;
revoke all on function m2o_proxy_sweep() from public;
grant execute on function m2o_proxy_sweep() to m2office_app;
