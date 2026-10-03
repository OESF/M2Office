-- 問い合わせがどの LINE の相手のものか（返事を送る先。相手が新しい問い合わせを始めても、前の問い合わせに返せる。仕様書 第33.19節）
alter table inquiries add column if not exists line_user_id text;
