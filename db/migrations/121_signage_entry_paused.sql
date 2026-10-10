-- サイネージの流れの行を止めておく（仕様書 第31.6.2節・第31.9.4節。第 0.329.0 版）
--
-- 行ごとのスライドスイッチで止める・再開する。止めた行は流れに残したまま、画面には流さない。
-- 時間帯の流れの行がすべて止まっていれば、空のときと同じく、いつもの流れを流す。

alter table signage_entries add column if not exists paused boolean not null default false;
