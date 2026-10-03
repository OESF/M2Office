-- 問い合わせの次にやることが、どの会話の履歴から生まれたかを持つ（仕様書 第33.17節）
-- 別の問い合わせに分けるとき、その履歴から生まれた次にやることも一緒に移す。前からある行は空のまま（分けても移さない）
alter table inquiry_tasks add column if not exists event_id text;
