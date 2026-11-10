-- 利用規約（クラウド版）の本文を M2Office が持ち、申し込みのページのダイアログで見せる（仕様書 第23.3.1節。第 0.542.0 版）
--
-- 本文は運営主体の名前を含むので、リポジトリに置かず、運営者がマスター管理画面の「料金の設定」で版と一緒に入れる（Markdown）。
-- 申し込みを受け付けるのは、版と本文がそろったときだけ。

alter table ops.billing_settings add column if not exists terms_text text not null default '';

-- 受け付けているか（移行 182 の同じ関数を、本文がそろっていることも見るように置き換える。182 は毎回当て直されるので、ここで必ず置き換える）
create or replace function ops.signup_status()
  returns table (open boolean, monthly_price_jpy integer, annual_price_jpy integer, tax_percent integer, terms_version text)
  language sql stable security definer set search_path = pg_catalog, ops as $$
  select signup_open and terms_version <> '' and terms_text <> '', monthly_price_jpy, annual_price_jpy, tax_percent, terms_version from ops.billing_settings where id = 1;
$$;

-- 申し込みのページが見せる利用規約（版と本文）
create or replace function ops.signup_terms()
  returns table (version text, body text)
  language sql stable security definer set search_path = pg_catalog, ops as $$
  select terms_version, terms_text from ops.billing_settings where id = 1;
$$;

revoke all on function ops.signup_terms() from public;
grant execute on function ops.signup_terms() to m2office_signup;
