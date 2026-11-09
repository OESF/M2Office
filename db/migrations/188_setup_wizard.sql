-- 管理者のセットアップウィザード（仕様書 第6.10.3節、ADR-0130。第 0.536.0 版）
--
-- ウィザードは、この版の後に作られた会社の管理者にだけ出す。済んだかどうかは、会社の設定の初期設定の区分
-- （tenant_settings.onboarding）の wizardDoneAt に持つ。値が無い会社には、ログインのたびにウィザードを出す。
-- それより前からある会社（動いている会社）の管理者に急に出さないよう、いまある会社をすべて済みにする。
--
-- 移行のファイルは毎回すべて当て直されるため、一度だけ行う印（m2o_data_fixes。移行 115）を使う。
-- 印が無いと、移行のたびに、そのあとで申し込んだ会社まで済みにしてしまう。

do $$
declare
  stamp jsonb := jsonb_build_object('wizardDoneAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
begin
  if exists (select 1 from m2o_data_fixes where id = 'setup-wizard-baseline-0.536') then return; end if;
  insert into tenant_settings (tenant_id, onboarding)
  select t.id, stamp from tenants t
  on conflict (tenant_id) do update
     set onboarding = coalesce(tenant_settings.onboarding, '{}'::jsonb) || stamp
   where not (coalesce(tenant_settings.onboarding, '{}'::jsonb) ? 'wizardDoneAt');
  insert into m2o_data_fixes (id) values ('setup-wizard-baseline-0.536');
end $$;
