-- 失敗した業務を、管理者が確認したら消せるようにする（仕様書 第6.7.5.1節。第 0.251.0 版）
-- 消すのはダッシュボードの「今日、失敗した業務」の表示だけ。実行の記録は残し、確認した人と日時を足す
alter table runs add column if not exists failure_dismissed_at timestamptz;
alter table runs add column if not exists failure_dismissed_by text;
