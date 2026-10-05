-- コラムのテーマ案にニュースと制度の変更を足す（仕様書 第32.18.7節。第 0.263.0 版）
-- 材料の印に「ニュース」を足し、もとにした出典（題名と URL）を持たせる
alter table web_column_themes drop constraint if exists web_column_themes_source_check;
alter table web_column_themes add constraint web_column_themes_source_check
  check (source in ('topic', 'season', 'search', 'competitor', 'question', 'rewrite', 'news'));
alter table web_column_themes add column if not exists source_title text not null default '';
alter table web_column_themes add column if not exists source_url text not null default '';
