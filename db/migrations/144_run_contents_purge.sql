-- 採用支援（AG-16）の応募書類と結果を消す（仕様書 第9.6.6節。第 0.382.0 版。Q-239、ADR-0103）
--
-- 実行の中身（ステップの入出力・成果物・依頼の入力・扱ったファイル）を消した時刻。消した実行は二度と見ない。
alter table runs add column if not exists contents_purged_at timestamptz;
