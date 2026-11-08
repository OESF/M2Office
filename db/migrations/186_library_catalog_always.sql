-- 資料（仕様書 第44章）の段 5。目録（OKF）を常に書き出す（第44.16節。第 0.532.0 版、ADR-0127）。
-- 入り切り（okf_enabled）はやめる（列は残すが読まない）。目録の変わり目を覚え、変わった人だけを書き直す。
--
-- 巻き戻し: 前の版に戻しても動く（足した列は読まれない）。消すなら
--   alter table library_owner_state drop column okf_stamp;

alter table library_owner_state add column if not exists okf_stamp text not null default '';
