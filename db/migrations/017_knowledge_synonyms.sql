-- 組織知識の言い換え（仕様書 第11.7.7節）
-- 標準の言い換えを使うかと、自社の言い換えの組を、会社の設定の区分 knowledge に持つ
alter table tenant_settings add column if not exists knowledge jsonb;
