-- 運営者が 1 人だけのときの 2 人の決まり（仕様書 第23.8.6節、Q-288、ADR-0116。第 0.487.0 版）
--
-- 停止と再開の承認と緊急停止の事後の確認は、申請した人とは別の運営者が行う。ほかに承認できる運営者（使える状態の運営管理者とサポート）が
-- 1 人もいないときだけ、申請した本人が 1 人で行う理由を書いて行える。理由は申請の記録に残し、会社の監査ログにも 1 人で行ったことを残す。
-- 判定は承認・確認のたびにこの関数の中で行うので、2 人目の運営者を足せば自動で 2 人の決まりに戻る。
-- 巻き戻し: 4 つの引数の ops.decide_status・ops.confirm_lock と ops.solo_operator を消し、移行 113 の 3 つ・2 つの引数の関数を作り直し、
-- 足した 2 つの列を消す（ほかの表から参照されない）。

alter table ops.status_requests add column if not exists decided_solo_note text;
alter table ops.status_requests add column if not exists confirmed_solo_note text;

-- 運営者が、承認できるただ 1 人の運営者か（本人が使える状態の運営管理者かサポートで、ほかにそういう運営者がいない）
create or replace function ops.solo_operator(p_operator text)
  returns boolean
  language sql stable security definer set search_path = pg_catalog, ops as $$
  select exists (select 1 from ops.operators where id = p_operator and status = 'active' and role in ('admin', 'support'))
     and not exists (select 1 from ops.operators where id <> p_operator and status = 'active' and role in ('admin', 'support'));
$$;
revoke all on function ops.solo_operator(text) from public;
grant execute on function ops.solo_operator(text) to m2office_ops;

-- 申請した本人が行おうとしたときの確かめ。1 人で行えるなら、書いた理由（前後の空白を除く）を返す
create or replace function ops._solo_note(p_operator text, p_note text)
  returns text
  language plpgsql stable security definer set search_path = pg_catalog, ops as $$
begin
  if not ops.solo_operator(p_operator) then raise exception 'same_operator'; end if;
  if coalesce(btrim(p_note), '') = '' then raise exception 'solo_note_required'; end if;
  return btrim(p_note);
end;
$$;
revoke all on function ops._solo_note(text, text) from public;

drop function if exists ops.decide_status(text, boolean, text);
drop function if exists ops.confirm_lock(text, text);

-- 申請を承認するか、しない。申請した人は、ほかに承認できる運営者がいないときだけ、理由を書いて行える
create or replace function ops.decide_status(p_request text, p_approve boolean, p_operator text, p_solo_note text default null)
  returns text
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare
  r ops.status_requests%rowtype;
  v_to text;
  v_at timestamptz := now() + interval '7 days';
  v_solo text;
  v_detail jsonb;
begin
  select * into r from ops.status_requests where id = p_request for update;
  if r.id is null then raise exception 'not_found'; end if;
  if r.state <> 'pending' then raise exception 'not_pending'; end if;
  if r.requested_by = p_operator then v_solo := ops._solo_note(p_operator, p_solo_note); end if;
  v_detail := jsonb_build_object('request', r.id) || case when v_solo is null then '{}'::jsonb else jsonb_build_object('solo', true, 'soloNote', v_solo) end;
  if not p_approve then
    update ops.status_requests set state = 'rejected', decided_by = p_operator, decided_at = now(), decided_solo_note = v_solo where id = p_request;
    perform ops._tenant_notice(r.tenant_id, 'tenant.' || r.kind || '_rejected', 'ops:' || p_operator, '', '', v_detail);
    return 'rejected';
  end if;
  if r.kind = 'suspend' then
    update ops.status_requests set state = 'scheduled', decided_by = p_operator, decided_at = now(), effective_at = v_at, decided_solo_note = v_solo where id = p_request;
    perform ops._tenant_notice(r.tenant_id, 'tenant.suspend_scheduled', 'ops:' || p_operator,
      'ご利用の停止の予告',
      to_char(v_at at time zone 'Asia/Tokyo', 'FMMM"月"FMDD"日"') || 'にご利用を停止します。停止のあとは閲覧だけができます。理由と解除の方法は、運営からご連絡します。',
      v_detail || jsonb_build_object('effectiveAt', v_at));
    return 'scheduled';
  end if;
  if r.kind = 'resume' then
    v_to := coalesce((select s.from_status from ops.status_requests s where s.tenant_id = r.tenant_id and s.kind in ('suspend', 'lock') and s.state = 'done' order by s.done_at desc limit 1), 'active');
    if v_to not in ('trial', 'active') then v_to := 'active'; end if;
    update tenants set status = v_to where id = r.tenant_id and status in ('suspended', 'locked');
    update ops.status_requests set state = 'done', decided_by = p_operator, decided_at = now(), done_at = now(), decided_solo_note = v_solo where id = p_request;
    perform ops._tenant_notice(r.tenant_id, 'tenant.resume', 'ops:' || p_operator, 'ご利用を再開しました', 'ご利用を再開しました。これまでどおりお使いいただけます。',
      v_detail || jsonb_build_object('to', v_to));
    return 'done';
  end if;
  raise exception 'kind_invalid';
end;
$$;

-- 緊急停止を、事後に別の運営者が確かめる。発動した人は、ほかに承認できる運営者がいないときだけ、理由を書いて確かめられる
create or replace function ops.confirm_lock(p_request text, p_operator text, p_solo_note text default null)
  returns void
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare
  r ops.status_requests%rowtype;
  v_solo text;
begin
  select * into r from ops.status_requests where id = p_request for update;
  if r.id is null or r.kind <> 'lock' then raise exception 'not_found'; end if;
  if r.confirmed_at is not null then raise exception 'not_pending'; end if;
  if r.requested_by = p_operator then v_solo := ops._solo_note(p_operator, p_solo_note); end if;
  update ops.status_requests set confirmed_by = p_operator, confirmed_at = now(), confirmed_solo_note = v_solo where id = p_request;
  perform ops._tenant_notice(r.tenant_id, 'tenant.lock_confirmed', 'ops:' || p_operator, '', '',
    jsonb_build_object('request', r.id) || case when v_solo is null then '{}'::jsonb else jsonb_build_object('solo', true, 'soloNote', v_solo) end);
end;
$$;

revoke all on function ops.decide_status(text, boolean, text, text) from public;
revoke all on function ops.confirm_lock(text, text, text) from public;
grant execute on function ops.decide_status(text, boolean, text, text) to m2office_ops;
grant execute on function ops.confirm_lock(text, text, text) to m2office_ops;
