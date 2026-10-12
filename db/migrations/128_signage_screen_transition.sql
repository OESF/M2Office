-- 店頭サイネージの画面ごとの切り替え方と画像の動き（仕様書 第31.6.2節。第 0.343.0 版）
--
-- 切り替え方は fade（既定）・slide・wipe・zoom・none。画像の動き（ken_burns）は、静止画をゆっくり拡大する（既定は切り）。
alter table signage_screens add column if not exists transition text not null default 'fade';
alter table signage_screens add column if not exists ken_burns boolean not null default false;
alter table signage_screens drop constraint if exists signage_screens_transition_check;
alter table signage_screens add constraint signage_screens_transition_check check (transition in ('fade', 'slide', 'wipe', 'zoom', 'none'));
