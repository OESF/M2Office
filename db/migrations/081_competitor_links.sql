-- 拡張どうしのつなぎ（仕様書 第36.21節・第34.20節。第 0.247.0 版）
-- 競合の分析のレポートに、出すとよいお知らせの案（競合の名前は入れない）と、変わった事実の種類ごとの数を添える
alter table competitor_reports add column if not exists announcement_ideas jsonb not null default '[]';
alter table competitor_reports add column if not exists change_kinds jsonb not null default '{}';
