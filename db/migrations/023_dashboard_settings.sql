-- ダッシュボードの見せ方（仕様書 第6.7.4.1節、Q-64、ADR-0013）
-- 人の状態を個人名で出すか、人数と業務だけにするか。既定は個人名。
alter table tenant_settings add column if not exists dashboard jsonb;
