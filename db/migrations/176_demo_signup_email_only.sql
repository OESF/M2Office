-- 体験版の自分での申し込みで、メールアドレスの控えだけを持つ（仕様書 第23.3.2節「自分で申し込む」、Q-289、ADR-0117。第 0.491.0 版）
--
-- 2026-10-30 に三浦さんが、情報漏洩を避けるため、体験版を動かすのに要らない情報は入れさせないと決めた。
-- 申し込みで聞くのはメールアドレスだけにし、「同じ人は 1 回だけ」の確かめに使う元に戻せない控え（移行 174 の ops.demo_signup_emails）だけを持つ。
-- 会社名・お名前・メールアドレスの文字は、どこにも残さない。すでに入っている自分で申し込んだ体験の分も、ここで空にする（体験そのものは続く）。
-- 運営者が出す体験（ops.create_demo）は、運営者が入れた相手の情報をこれまでどおり持つ（終えてから 90 日で消す）。
-- 巻き戻し: 5 つの引数の m2o_demo_self_signup を消せば、前の版に戻したときに移行 174 の 8 つの引数の関数が作り直される。空にした相手の情報は戻らない。

update ops.demo_guests set company = '', contact = '', email = '', contact_purged_at = coalesce(contact_purged_at, now())
 where origin = 'self' and (company <> '' or contact <> '' or email <> '');

drop function if exists m2o_demo_self_signup(text, text, text, text, text, text, text, text);

-- アプリ: 自分で申し込む（既定の日数と上限で、体験用の会社を 1 つ作る）。
-- p_email_key はそろえた形のメールアドレス（控えを作るためだけに使い、文字のままは残さない）、p_addr は送り元のアドレス。
-- 断る理由: signup_closed（使わない設定）・signup_invalid（入力）・signup_email_used・signup_source_used・signup_daily_limit・signup_budget
create or replace function m2o_demo_self_signup(p_login text, p_hash text, p_email_key text, p_addr text, p_name text)
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
  if coalesce(p_email_key, '') !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or length(p_email_key) > 200 or coalesce(p_addr, '') = '' then
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
  select * into d from ops.create_demo(p_login, p_hash, '', '', '', s.demo_days, s.demo_ai_cap_jpy, p_name, 'self-signup');
  update ops.demo_guests g set origin = 'self', terms_accepted_at = now() where g.id = d.guest_id;
  insert into ops.demo_signup_emails (email_hash) values (v_email);
  insert into ops.demo_signup_sources (addr_hash) values (v_addr);
  insert into ops.audit (id, operator_id, action, target_type, target_id, detail)
    values (gen_random_uuid()::text, 'self-signup', 'demo.self_signup', 'demo', d.guest_id,
            jsonb_build_object('loginId', p_login, 'days', s.demo_days, 'aiCapJpy', s.demo_ai_cap_jpy));
  return query select d.guest_id, d.tenant_id, 'u-' || p_login, d.expires_at;
end $$;
revoke all on function m2o_demo_self_signup(text, text, text, text, text) from public;
grant execute on function m2o_demo_self_signup(text, text, text, text, text) to m2office_app;
