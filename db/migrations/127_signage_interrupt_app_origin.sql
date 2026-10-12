-- 店頭サイネージの割り込みの出どころに、外部のアプリ（app）を足す（仕様書 第13.4.3節。第 0.342.0 版）
--
-- 外部のアプリの機能「サイネージに呼び出しを出す」（signage.interrupt）で出した割り込みは、出どころを app にし、
-- 出した人（created_by）に app:<アプリの ID> を入れる。移行は毎回すべて当て直すため、制約は消してから作り直す。
alter table signage_interrupts drop constraint if exists signage_interrupts_origin_check;
alter table signage_interrupts add constraint signage_interrupts_origin_check check (origin in ('staff', 'secretary', 'hook', 'app'));
