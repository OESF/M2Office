-- ダッシュボード（仕様書 第6.7節）
-- 削減時間の推計（第6.7.12節）を実行ごとに記録する。完了した時点の値を残し、後から変えない。
alter table runs add column if not exists saved_minutes numeric(8,1) not null default 0;

-- 効果の推計の設定（エージェントごとの標準所要時間）
alter table tenant_settings add column if not exists effect jsonb;
