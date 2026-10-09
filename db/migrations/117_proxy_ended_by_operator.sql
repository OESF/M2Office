-- 代理アクセスを運営者の側から終えたことを、会社が切ったこととは別の状態にする（仕様書 第23.6.1節。第 0.320.0 版）
--
-- これまでは運営者が「終える」を押しても revoked（会社の管理者が切った）として残り、運営の画面には「切られた」、
-- 会社の画面には「切った」と出て、誰が終えたかが逆に見えていた。運営者が終えたときは ended にする。
-- 移行は毎回すべて当て直すため、制約は外してから付け直す。

alter table proxy_grants drop constraint if exists proxy_grants_state_check;
alter table proxy_grants add constraint proxy_grants_state_check
  check (state in ('requested', 'approved', 'denied', 'revoked', 'ended', 'withdrawn', 'expired'));

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
    update proxy_grants set state = 'ended', ended_at = now(), ticket_hash = null where id = p_grant;
  else
    raise exception 'not_pending';
  end if;
  delete from proxy_sessions where grant_id = p_grant;
  perform ops._tenant_notice(g.tenant_id, 'proxy.end', 'ops:' || p_operator, '', '', jsonb_build_object('grant', g.id));
end;
$$;

-- 期限が来たか、切られたか、運営者が終えた閲覧の、終わったあとの知らせ（ワーカーがアプリのロールで 1 分ごとに呼ぶ）
create or replace function m2o_proxy_sweep()
  returns integer
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare g record; n integer := 0; v_views bigint;
begin
  for g in select * from proxy_grants
            where notified_at is null and ((state = 'approved' and expires_at <= now()) or state in ('revoked', 'ended')) for update skip locked loop
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
