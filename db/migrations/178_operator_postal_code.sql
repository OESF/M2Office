-- 運営主体の郵便番号（仕様書 第23.8.14節）
--
-- 所在地の前に郵便番号を持つ（利用規約・請求書・資料の事業者の表記で、所在地と一緒に使う）。入れていなければ空。
-- 顧客の側が読む関数 m2o_operator_profile（移行 112）は変えない（顧客の側は法人名しか使わない。また、移行は毎回はじめから当て直すので、
-- 返す列を変えると移行 112 の作り直しで止まる）。郵便番号は運営の画面だけが ops.operator_profile から読む。
-- 巻き戻し: ops.operator_profile から postal_code の列を消す（ほかの表から参照されない）。前の版に戻しても動く。
alter table ops.operator_profile add column if not exists postal_code text not null default '';
