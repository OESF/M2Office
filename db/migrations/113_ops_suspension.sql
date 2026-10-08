-- マスター管理画面の段 2: 利用の停止と再開（仕様書 第23.8.6節。第 0.310.0 版）
--
-- 通常の停止は 2 人の承認と 7 日の予告、緊急停止は運営者なら誰でも発動しすぐ止め事後に別の人が確認、再開は 2 人の承認。
-- 記録は ops.status_requests に持ち、状態の変更は所有者の権限で動く決めた関数だけで行う（申請した人が自分で承認できないことも関数で確かめる）。
-- 会社の管理者へは M2Office の中の通知（種類 service）で知らせる。運営の画面は社外に送らない。

create table if not exists ops.status_requests (
  id            text primary key,
  tenant_id     text not null,
  -- suspend（通常の停止）・lock（緊急停止）・resume（再開）
  kind          text not null check (kind in ('suspend', 'lock', 'resume')),
  reason_code   text not null,
  reason        text not null,
  -- pending（承認待ち）・scheduled（承認済み。期限で止める）・done（行った）・rejected（承認しなかった）・withdrawn（取り下げた）
  state         text not null check (state in ('pending', 'scheduled', 'done', 'rejected', 'withdrawn')),
  -- 止める前の状態（再開で戻す先）
  from_status   text,
  requested_by  text not null,
  requested_at  timestamptz not null default now(),
  decided_by    text,
  decided_at    timestamptz,
  effective_at  timestamptz,
  done_at       timestamptz,
  -- 緊急停止の事後の確認（申請した人とは別の運営者）
  confirmed_by  text,
  confirmed_at  timestamptz
);
create index if not exists ops_status_requests_tenant on ops.status_requests (tenant_id, requested_at desc);
create index if not exists ops_status_requests_due on ops.status_requests (effective_at) where state = 'scheduled';
grant select on ops.status_requests to m2office_ops;

-- 会社の管理者へ M2Office の中の通知を届け、会社の監査ログに残す（内部の手助け）
create or replace function ops._tenant_notice(p_tenant text, p_action text, p_operator text, p_title text, p_body text, p_detail jsonb)
  returns void
  language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  insert into notifications (id, tenant_id, user_id, kind, title, body, created_at)
    select gen_random_uuid()::text, p_tenant, u.id, 'service', p_title, p_body, now()
      from users u where u.tenant_id = p_tenant and u.status = 'active' and 'admin' = any (u.roles) and p_title <> '';
  insert into audit_events (id, tenant_id, actor_type, actor_id, action, target_type, target_id, detail, occurred_at)
    values (gen_random_uuid()::text, p_tenant, 'system', p_operator, p_action, 'tenant', p_tenant, p_detail, now());
end;
$$;
revoke all on function ops._tenant_notice(text, text, text, text, text, jsonb) from public;

-- 停止・緊急停止・再開を申請する。緊急停止はすぐに止める
create or replace function ops.request_status(p_tenant text, p_kind text, p_reason_code text, p_reason text, p_operator text)
  returns text
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare
  v_id text := gen_random_uuid()::text;
  v_status text;
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  select status into v_status from tenants where id = p_tenant for update;
  if v_status is null then raise exception 'not_found'; end if;
  if p_kind = 'suspend' then
    if v_status not in ('trial', 'active') then raise exception 'status_locked'; end if;
    if exists (select 1 from ops.status_requests where tenant_id = p_tenant and kind = 'suspend' and state in ('pending', 'scheduled')) then raise exception 'already_requested'; end if;
    insert into ops.status_requests (id, tenant_id, kind, reason_code, reason, state, from_status, requested_by)
      values (v_id, p_tenant, 'suspend', p_reason_code, p_reason, 'pending', v_status, p_operator);
    perform ops._tenant_notice(p_tenant, 'tenant.suspend_requested', 'ops:' || p_operator, '', '', jsonb_build_object('reasonCode', p_reason_code, 'request', v_id));
  elsif p_kind = 'lock' then
    if v_status not in ('trial', 'active', 'suspended') then raise exception 'status_locked'; end if;
    insert into ops.status_requests (id, tenant_id, kind, reason_code, reason, state, from_status, requested_by, decided_by, decided_at, done_at)
      values (v_id, p_tenant, 'lock', p_reason_code, p_reason, 'done',
              -- 通常の停止の間に緊急停止したら、再開で戻す先は止める前の状態にする
              case when v_status = 'suspended' then coalesce((select r.from_status from ops.status_requests r where r.tenant_id = p_tenant and r.kind = 'suspend' and r.state = 'done' order by r.done_at desc limit 1), 'active') else v_status end,
              p_operator, p_operator, now(), now());
    update tenants set status = 'locked' where id = p_tenant;
    -- 予告中の通常の停止は、緊急停止に置き換える
    update ops.status_requests set state = 'withdrawn', decided_at = coalesce(decided_at, now()) where tenant_id = p_tenant and kind = 'suspend' and state in ('pending', 'scheduled');
    perform ops._tenant_notice(p_tenant, 'tenant.lock', 'ops:' || p_operator, '', '', jsonb_build_object('reasonCode', p_reason_code, 'from', v_status, 'request', v_id));
  elsif p_kind = 'resume' then
    if v_status not in ('suspended', 'locked') then raise exception 'not_stopped'; end if;
    if exists (select 1 from ops.status_requests where tenant_id = p_tenant and kind = 'resume' and state = 'pending') then raise exception 'already_requested'; end if;
    insert into ops.status_requests (id, tenant_id, kind, reason_code, reason, state, from_status, requested_by)
      values (v_id, p_tenant, 'resume', p_reason_code, p_reason, 'pending', v_status, p_operator);
    perform ops._tenant_notice(p_tenant, 'tenant.resume_requested', 'ops:' || p_operator, '', '', jsonb_build_object('request', v_id));
  else
    raise exception 'kind_invalid';
  end if;
  return v_id;
end;
$$;

-- 申請を承認するか、しない。申請した人は承認できない。通常の停止は 7 日後に止める予定にし、再開はすぐに戻す
create or replace function ops.decide_status(p_request text, p_approve boolean, p_operator text)
  returns text
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare
  r ops.status_requests%rowtype;
  v_to text;
  v_at timestamptz := now() + interval '7 days';
begin
  select * into r from ops.status_requests where id = p_request for update;
  if r.id is null then raise exception 'not_found'; end if;
  if r.state <> 'pending' then raise exception 'not_pending'; end if;
  if r.requested_by = p_operator then raise exception 'same_operator'; end if;
  if not p_approve then
    update ops.status_requests set state = 'rejected', decided_by = p_operator, decided_at = now() where id = p_request;
    perform ops._tenant_notice(r.tenant_id, 'tenant.' || r.kind || '_rejected', 'ops:' || p_operator, '', '', jsonb_build_object('request', r.id));
    return 'rejected';
  end if;
  if r.kind = 'suspend' then
    update ops.status_requests set state = 'scheduled', decided_by = p_operator, decided_at = now(), effective_at = v_at where id = p_request;
    perform ops._tenant_notice(r.tenant_id, 'tenant.suspend_scheduled', 'ops:' || p_operator,
      'ご利用の停止の予告',
      to_char(v_at at time zone 'Asia/Tokyo', 'FMMM"月"FMDD"日"') || 'にご利用を停止します。停止のあとは閲覧だけができます。理由と解除の方法は、運営からご連絡します。',
      jsonb_build_object('request', r.id, 'effectiveAt', v_at));
    return 'scheduled';
  end if;
  if r.kind = 'resume' then
    v_to := coalesce((select s.from_status from ops.status_requests s where s.tenant_id = r.tenant_id and s.kind in ('suspend', 'lock') and s.state = 'done' order by s.done_at desc limit 1), 'active');
    if v_to not in ('trial', 'active') then v_to := 'active'; end if;
    update tenants set status = v_to where id = r.tenant_id and status in ('suspended', 'locked');
    update ops.status_requests set state = 'done', decided_by = p_operator, decided_at = now(), done_at = now() where id = p_request;
    perform ops._tenant_notice(r.tenant_id, 'tenant.resume', 'ops:' || p_operator, 'ご利用を再開しました', 'ご利用を再開しました。これまでどおりお使いいただけます。',
      jsonb_build_object('request', r.id, 'to', v_to));
    return 'done';
  end if;
  raise exception 'kind_invalid';
end;
$$;

-- 承認の前か、止める前の通常の停止を取り下げる（その間に理由が解消したとき）
create or replace function ops.withdraw_status(p_request text, p_operator text)
  returns void
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare r ops.status_requests%rowtype;
begin
  select * into r from ops.status_requests where id = p_request for update;
  if r.id is null then raise exception 'not_found'; end if;
  if r.state not in ('pending', 'scheduled') then raise exception 'not_pending'; end if;
  update ops.status_requests set state = 'withdrawn' where id = p_request;
  perform ops._tenant_notice(r.tenant_id, 'tenant.' || r.kind || '_withdrawn', 'ops:' || p_operator,
    case when r.state = 'scheduled' then 'ご利用の停止の予告を取り消しました' else '' end,
    case when r.state = 'scheduled' then 'お知らせしていたご利用の停止は行いません。これまでどおりお使いいただけます。' else '' end,
    jsonb_build_object('request', r.id));
end;
$$;

-- 緊急停止を、事後に別の運営者が確かめる
create or replace function ops.confirm_lock(p_request text, p_operator text)
  returns void
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare r ops.status_requests%rowtype;
begin
  select * into r from ops.status_requests where id = p_request for update;
  if r.id is null or r.kind <> 'lock' then raise exception 'not_found'; end if;
  if r.confirmed_at is not null then raise exception 'not_pending'; end if;
  if r.requested_by = p_operator then raise exception 'same_operator'; end if;
  update ops.status_requests set confirmed_by = p_operator, confirmed_at = now() where id = p_request;
  perform ops._tenant_notice(r.tenant_id, 'tenant.lock_confirmed', 'ops:' || p_operator, '', '', jsonb_build_object('request', r.id));
end;
$$;

-- 期限の来た通常の停止を行う（ワーカーがアプリのロールで 1 分ごとに呼ぶ）
create or replace function m2o_ops_apply_due()
  returns integer
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare r record; n integer := 0;
begin
  for r in select * from ops.status_requests where state = 'scheduled' and effective_at <= now() for update skip locked loop
    update tenants set status = 'suspended' where id = r.tenant_id and status in ('trial', 'active');
    update ops.status_requests set state = 'done', done_at = now() where id = r.id;
    perform ops._tenant_notice(r.tenant_id, 'tenant.suspend', 'ops:' || r.decided_by, 'ご利用を停止しました',
      'ご利用を停止しました。閲覧だけができます。解除の方法は、運営からのご連絡をご覧ください。', jsonb_build_object('request', r.id));
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- 会社の画面に出す停止の予告（止める予定の日時。無ければ null）
create or replace function m2o_tenant_suspend_at(p_tenant text)
  returns timestamptz
  language sql stable security definer set search_path = pg_catalog, ops as $$
  select min(effective_at) from ops.status_requests where tenant_id = p_tenant and kind = 'suspend' and state = 'scheduled';
$$;

-- 会社の名前（申請の一覧に出す。運営の画面は会社の名前を見てよい）
create or replace function ops.tenant_names()
  returns table (id text, name text)
  language sql stable security definer set search_path = pg_catalog, public as $$
  select t.id, t.name from tenants t;
$$;
revoke all on function ops.tenant_names() from public;
grant execute on function ops.tenant_names() to m2office_ops;

revoke all on function ops.request_status(text, text, text, text, text) from public;
revoke all on function ops.decide_status(text, boolean, text) from public;
revoke all on function ops.withdraw_status(text, text) from public;
revoke all on function ops.confirm_lock(text, text) from public;
grant execute on function ops.request_status(text, text, text, text, text) to m2office_ops;
grant execute on function ops.decide_status(text, boolean, text) to m2office_ops;
grant execute on function ops.withdraw_status(text, text) to m2office_ops;
grant execute on function ops.confirm_lock(text, text) to m2office_ops;
revoke all on function m2o_ops_apply_due() from public;
revoke all on function m2o_tenant_suspend_at(text) from public;
grant execute on function m2o_ops_apply_due() to m2office_app;
grant execute on function m2o_tenant_suspend_at(text) to m2office_app;
