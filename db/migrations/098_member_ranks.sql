-- 会員のランクと、ランクだけの特典（仕様書 第40.19節）。ランクは直近 1 年の来店の回数から求め、表には持たない。
-- 特典に、使えるいちばん下のランクを持たせる（regular は全員）。

alter table member_rewards add column if not exists min_rank text not null default 'regular' check (min_rank in ('regular', 'silver', 'gold'));
