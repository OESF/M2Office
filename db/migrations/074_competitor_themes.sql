-- 競合の分析の段 3: レポートに添えるコラムの話題（仕様書 第36.20節。第 0.241.0 版）
-- 競合の名前は入れない（第36.9節）
alter table competitor_reports add column if not exists themes jsonb not null default '[]';
