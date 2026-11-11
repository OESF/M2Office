-- 機能ごとの学びを秘書の目に入れる（仕様書 第11.13.9節、ADR-0136。第 0.555.0 版。秘書の成長 段 6）
--
-- 本人の像を作るとき、メールの学び・よくやり取りする相手・メールのカテゴリーを材料にしたかの印を持たせる。
-- メールの一覧を消すとき（Google の連携の解除・データの削除の求め・退会。第14.3.2節）、この印の付いた本人の像を消し、
-- 次の見回りでメールの材料なしに作り直す。

alter table user_profiles add column if not exists used_mail boolean not null default false;
