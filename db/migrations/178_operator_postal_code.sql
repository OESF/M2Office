-- 運営主体の郵便番号（仕様書 第23.8.14節）
--
-- 所在地の前に郵便番号を持つ（利用規約・請求書・資料の事業者の表記で、所在地と一緒に使う）。入れていなければ空。
-- 顧客の側が読む関数 m2o_operator_profile も郵便番号を返す（返す列が変わるので作り直す）。
-- 巻き戻し: 関数を移行 112 の形に作り直し、ops.operator_profile から postal_code の列を消す（ほかの表から参照されない）。
alter table ops.operator_profile add column if not exists postal_code text not null default '';

drop function if exists m2o_operator_profile();
create function m2o_operator_profile()
  returns table (name_ja text, name_en text, postal_code text, address text, web text, contact text)
  language sql stable security definer set search_path = pg_catalog, ops as $$
  select name_ja, name_en, postal_code, address, web, contact from ops.operator_profile where id = 1;
$$;
revoke all on function m2o_operator_profile() from public;
grant execute on function m2o_operator_profile() to m2office_app;
