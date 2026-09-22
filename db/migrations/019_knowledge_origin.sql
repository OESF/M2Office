-- 組織知識の由来（仕様書 第9.5.2節、Q-85、ADR-0010）
-- 業務（AG-02 議事録作成・共有）から登録した知識に、登録した実行と、Google から読んだデータで作ったかを持つ。
-- 管理者が登録した知識は origin_run_id が null、google_derived が false。
-- どちらも最初に登録したときだけ書き、管理者が本文を直しても変えない。
alter table knowledge_items add column if not exists origin_run_id text;
alter table knowledge_items add column if not exists google_derived boolean not null default false;
