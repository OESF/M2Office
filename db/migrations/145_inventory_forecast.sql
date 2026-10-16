-- 在庫の需要の予測（仕様書 第29.14節。第 0.383.0 版。Q-116、ADR-0103）
--
-- 週に 1 回、決まった計算の土台（直近 4 週と去年の同じ時期の伸び）に、AI が季節・行事の倍率と理由を加えて、
-- 品目ごとの予測の目安と、使う速さの倍率を決め直す。会社が品目の目安を決めた品目（low_threshold）は変えない。
alter table inventory_items add column if not exists forecast_low numeric;
alter table inventory_items add column if not exists forecast_factor numeric;
alter table inventory_items add column if not exists forecast_note text;
alter table inventory_items add column if not exists forecast_at timestamptz;
