-- 案件とメールのカテゴリーを結ぶ（仕様書 第11.13.8節、ADR-0135。第 0.553.0 版。秘書の成長 段 5）
--
-- 案件ノートに、結んだメールのカテゴリー（mail_categories の ID。本人の中で 1 つの案件にだけ結ぶ）と、
-- メールの材料だけから作った印を持たせる。メールの一覧を消すとき（Google の連携の解除・データの削除の求め・退会）は、
-- 結びを外し、メールの材料だけから作った案件ノートを消す（第14.3.2節）。

alter table case_notes add column if not exists mail_category_id text;
alter table case_notes add column if not exists mail_only boolean not null default false;
create index if not exists case_notes_mail_idx on case_notes (tenant_id, user_id, mail_category_id) where mail_category_id is not null;
