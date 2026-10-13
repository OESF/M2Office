-- コラムのサイネージ用の動画の長さ（仕様書 第32.18.6節。第 0.349.0 版）
--
-- 頼んだ人が 8 秒（既定。Veo 3.1 Lite）か 15 秒（Veo 3.1 Fast で 8 秒を作り 7 秒延長）を選ぶ。画像の組と、前に作った動画の組は null（8 秒）。
alter table column_signage add column if not exists video_seconds integer;
alter table column_signage drop constraint if exists column_signage_video_seconds_check;
alter table column_signage add constraint column_signage_video_seconds_check check (video_seconds is null or video_seconds in (8, 15));
