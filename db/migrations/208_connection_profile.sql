-- 会社の接続の説明と、ツールの役割を管理者が見たか（仕様書 第47.4.1節・第47.7節。第 0.586.0 版。ADR-0148）。
-- 推論が作った「この接続で何ができるか」の説明は、秘書の振り分けの候補に出し、その接続の道具を使う汎用の業務を作る。
-- ツールごとの役割（読む・準備・見直し・確定・戻す）は、いまの tools（jsonb）の中に持つ。
--
-- 巻き戻し: 前の版に戻しても動く（足した列は読まれない。tools の中の役割も読まれない）。消すなら
--   alter table tenant_connections drop column profile;

alter table tenant_connections add column if not exists profile jsonb;
