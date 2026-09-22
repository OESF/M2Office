-- Google から取得したデータの保持（仕様書 第14.3.2節、Q-78）
-- 1. 実行ごとに、保持期間の処理を済ませた時刻と、中身を消した時刻を持つ。
--    checked_at があれば見回りの対象から外す。redacted_at は Google 由来の中身があって消したときだけ入る
alter table runs add column if not exists google_data_checked_at timestamptz;
alter table runs add column if not exists google_data_redacted_at timestamptz;
create index if not exists runs_retention_idx on runs (tenant_id, ended_at) where google_data_checked_at is null;

-- 2. 会社の設定の区分 privacy（Google から取得したデータを残す日数。0〜7、既定 7）
alter table tenant_settings add column if not exists privacy jsonb;
