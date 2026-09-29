-- 在庫管理の段 2（棚卸し）。仕様書 第29.10節、ADR-0050
--
-- 棚卸しは会社で同時に 1 つだけ開く（開いていれば「続きを数える」）。二重に始めて数が割れるのを、データベースでも防ぐ。
create unique index if not exists inventory_counts_open_idx on inventory_counts (tenant_id) where status = 'open';
-- 確定の調整の記録から、元の棚卸しを引く
create index if not exists inventory_moves_source_idx on inventory_moves (tenant_id, source, source_id);
