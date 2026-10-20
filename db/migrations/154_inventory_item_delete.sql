-- 品目の削除（仕様書 第29.6.3節、Q-252）
--
-- 記録（入出庫・棚卸し・発注・引き当て）のある品目は、記録を残したまま「削除した」印を付け、どこにも出さない。
-- 入出庫の記録は追記のみで消さないため、品目の行は残し、過去の記録から品名を引けるようにする。
-- 記録の無い品目は行ごと消す（バーコード・ロット・いまの数・メニューの対応は外部キーの cascade で消える）。
-- 巻き戻し: 列を消す前に、削除した品目（deleted_at が入った行）を止めた品目にしてから列を落とす。

alter table inventory_items add column if not exists deleted_at timestamptz;
alter table inventory_items add column if not exists deleted_by text;

create index if not exists inventory_items_live_idx on inventory_items (tenant_id, status, name) where deleted_at is null;
