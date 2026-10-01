-- ローカルの形と、外部の AI に渡さない決まり（仕様書 第8.6節・第16.3.7.1節、ADR-0059）
--
-- 会社の AI の方針（クラウド・ローカルを既定・ローカルだけ）を会社の設定に持つ。ローカルの形でだけ効く。
-- 会社の接続（社外のサービス）ごとに、ローカルの方針のときに送ってよいもの（送らない・個人を特定する情報を除いて送る）を持つ。

alter table tenant_settings add column if not exists ai_policy jsonb;
alter table tenant_connections add column if not exists send_policy text
  check (send_policy is null or send_policy in ('block', 'deidentified'));
