-- コラムのサイネージ用の画像と動画の作風（仕様書 第32.18.6節。第 0.351.0 版）
--
-- 作るときに real（リアル。既定）・illustration（イラスト）・anime（アニメ風）・fantasy（ファンタジー）から選ぶ。前に作った組は null。
alter table column_signage add column if not exists image_style text;
alter table column_signage drop constraint if exists column_signage_image_style_check;
alter table column_signage add constraint column_signage_image_style_check check (image_style is null or image_style in ('real', 'illustration', 'anime', 'fantasy'));
