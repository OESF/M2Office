-- コラムから作る店頭サイネージ用の動画（仕様書 第32.18.6節 段 2。第 0.257.0 版）
-- 動画を作った回数（会社で月 10 本の上限に数える。作り直しも数える）。絵の回数（ai_attempts）とは分けて数える
alter table column_signage add column if not exists video_attempts integer not null default 0;
