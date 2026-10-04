-- アプリの一覧を人ごとに編集する（仕様書 第6.1.1.2節。第 0.252.0 版）
-- 個人設定の区分: 出さない Google のサービスと、本人が登録したほかのサイトのリンク（1 人 20 件まで）
alter table user_settings add column if not exists launcher jsonb;
