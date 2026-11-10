-- メールの学び（仕様書 第9.5.1.1.2節、ADR-0133。第 0.549.0 版）
--
-- 本人の直し（振り分け・カテゴリー）とふるまい（返事をせずに片付けた・すぐ開いた・開かずにアーカイブした・返事をした）から、
-- 相手ごとの傾向を覚える。モデルは学習させず、次の推論に例として渡す（第11.9.3節の「システムの蓄積」）。
-- 見られるのは本人だけ。メールの一覧と同じく、Google の連携の解除・データの削除の求め・退会ですぐ消す（第14.3.2節）。
-- 会社の知識には昇華しない（個人記憶とは別に持つ）。

create table if not exists mail_lessons (
  tenant_id   text not null references tenants(id) on delete cascade,
  user_id     text not null references users(id) on delete cascade,
  id          text not null,
  -- group（振り分け）・category（カテゴリー）・style（返事の書き方）
  kind        text not null,
  -- 何に当てるか: from（メールアドレス）・domain・subject（件名の頭の決まった形）
  key_type    text not null,
  key_value   text not null,
  -- 分け先（group: reply・action・read・promo・important。category: カテゴリーの名前。style: shorter・longer）
  target      text not null,
  -- told（本人の直し）・behavior（ふるまい）
  source      text not null,
  -- 例として残す件名（本人の直しのとき。カテゴリーの例に使う）
  subject     text not null default '',
  -- ふるまいがあった時刻（60 日の間に 3 回そろったら傾向にする）
  hits        jsonb not null default '[]'::jsonb,
  first_at    timestamptz not null default now(),
  last_at     timestamptz not null default now(),
  -- 振り分けで最後に当てた時刻（90 日当たらなければ消す）
  used_at     timestamptz not null default now(),
  primary key (tenant_id, user_id, id)
);
create index if not exists mail_lessons_key_idx on mail_lessons (tenant_id, user_id, kind, key_type, key_value);

alter table mail_lessons enable row level security;
drop policy if exists tenant_isolation on mail_lessons;
create policy tenant_isolation on mail_lessons using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on mail_lessons to m2office_app;

-- 週ごとの数（直した回数・振り分けの外れ）。数だけを持ち、メールの中身は持たない
create table if not exists mail_learning_weeks (
  tenant_id    text not null references tenants(id) on delete cascade,
  user_id      text not null references users(id) on delete cascade,
  -- その週の月曜日（日本時間）
  week         date not null,
  corrections  integer not null default 0,
  misses       integer not null default 0,
  primary key (tenant_id, user_id, week)
);

alter table mail_learning_weeks enable row level security;
drop policy if exists tenant_isolation on mail_learning_weeks;
create policy tenant_isolation on mail_learning_weeks using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on mail_learning_weeks to m2office_app;

-- 第 0.547.0 版で mail_watch.prefs.categoryLessons に置いたカテゴリーの直しを、mail_lessons に移す（一度だけ）
do $$
begin
  if exists (select 1 from m2o_data_fixes where id = 'mail-lessons-from-prefs-0.549') then return; end if;
  insert into mail_lessons (tenant_id, user_id, id, kind, key_type, key_value, target, source, subject)
  select w.tenant_id, w.user_id, 'ml-' || md5(w.tenant_id || w.user_id || (l ->> 'from') || (l ->> 'subject')),
         'category', 'from', lower(l ->> 'from'), coalesce(l ->> 'category', ''), 'told', coalesce(l ->> 'subject', '')
    from mail_watch w, jsonb_array_elements(coalesce(w.prefs -> 'categoryLessons', '[]'::jsonb)) l
   where coalesce(l ->> 'from', '') <> ''
  on conflict do nothing;
  update mail_watch set prefs = prefs - 'categoryLessons' where prefs ? 'categoryLessons';
  insert into m2o_data_fixes (id) values ('mail-lessons-from-prefs-0.549');
end $$;

-- 運営: 本人が共有を頼んだ人の、週ごとの数だけ（ベータテスト。第9.5.1.1.2節「ベータテスト」）。
-- 名前・メールアドレス・メールの中身は返さない。人は、会社と利用者の ID から作った番号で表す
create or replace function ops.mail_learning_shared()
  returns table (tenant_id text, person text, week date, corrections integer, misses integer)
  language sql stable security definer set search_path = pg_catalog, public as $$
  select k.tenant_id, substr(md5(k.tenant_id || ':' || k.user_id), 1, 8), k.week, k.corrections, k.misses
    from mail_learning_weeks k
    join mail_watch w on w.tenant_id = k.tenant_id and w.user_id = k.user_id
   where (w.prefs ->> 'shareLearning') = 'true'
     and k.week >= (current_date - 84)
   order by k.tenant_id, 2, k.week;
$$;
revoke all on function ops.mail_learning_shared() from public;
grant execute on function ops.mail_learning_shared() to m2office_ops;
