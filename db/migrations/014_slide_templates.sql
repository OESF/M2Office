-- スライドのテンプレート（仕様書 第9.4.2節「スライドのテンプレート」、Q-77）
-- Google スライドのファイルの ID・名前・説明・既定かどうかを、会社の設定の区分 slides に持つ
alter table tenant_settings add column if not exists slides jsonb;
