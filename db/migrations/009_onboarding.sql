-- 初回の案内と、管理者の初期設定の進み具合（仕様書 第6.10.3節）
-- 他のデータから判定できるもの（会社情報・知識の件数など）はここに持たない。
alter table user_settings add column if not exists onboarding jsonb;
alter table tenant_settings add column if not exists onboarding jsonb;
