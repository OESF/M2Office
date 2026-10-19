-- 曜日の波とメーカーの終売（仕様書 第29.14.3節・第29.24.1節。第 0.410.0 版。Q-248）
--
-- forecast_weekdays: 品目ごとの曜日の重み（日曜はじまりの 7 つ。営業日でない曜日は 0）。週に 1 回の需要の予測と一緒に決め直す。
--                    記録の足りない品目は null（平らに数える）。
-- discontinued: 終売の見込み {"current": {status, date, successor, url, source, checkedAt} | null, "dismissed": [出典の URL]}。
--               相場の調べものか、秘書に渡された仕入先の知らせで付け、管理者が「終売ではない」で外す（同じ出典では付け直さない）。
alter table inventory_items add column if not exists forecast_weekdays jsonb;
alter table inventory_items add column if not exists discontinued jsonb;
