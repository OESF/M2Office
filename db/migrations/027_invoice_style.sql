-- 帳票の体裁（仕様書 第15.2.2節、Q-57）
-- ロゴ・振込先・支払期限の既定・備考の定型文・印の欄。自社の書き方（文章の規則）とは分けて持つ。
alter table tenant_settings add column if not exists invoice jsonb;
