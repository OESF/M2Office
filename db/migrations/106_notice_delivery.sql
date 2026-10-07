-- 社内のお知らせのブリーフ以外の届け方（仕様書 第10.15.1節、ADR-0080。第 0.298.0 版）。
-- 受け取った人ごとに、締切の前の知らせを送った日時（3 日前・当日）と、「もう知らせないで」の日時を持つ。
-- お知らせごとに、投稿した Chat のスペースの名前を持つ（投稿は 1 回だけ）。

alter table notice_receipts add column if not exists muted_at timestamptz;
alter table notice_receipts add column if not exists reminded_before_at timestamptz;
alter table notice_receipts add column if not exists reminded_due_at timestamptz;
alter table notices add column if not exists chat_space text;
