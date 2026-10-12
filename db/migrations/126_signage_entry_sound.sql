-- 店頭サイネージの流れの動画の行で、音を出すか（仕様書 第31.6節・第31.9.1節。第 0.340.0 版）
--
-- 既定は音なし（それまでは常に消していた）。同じ動画でも、画面ごと・時間帯の流れごとに決められる。
alter table signage_entries add column if not exists sound boolean not null default false;
