-- 個人設定の「表示」（仕様書 第6.1節・第6.5.6節、ADR-0122）。文字の大きさの段（小さい・標準・大きい）を人ごとに持つ。
-- 明るさは端末ごとに覚えるので、ここには持たない。列が空なら既定（標準）。
alter table user_settings add column if not exists display jsonb;
