-- メールのカテゴリー（仕様書 第9.5.1.1.1節、ADR-0132。第 0.547.0 版）
--
-- AI がメールから作る、本人の仕事のまとまり（プロジェクト・取引先・続いている用件）。M2Office の中だけのもので、Gmail のラベルにはしない。
-- 見られるのは本人だけ。メールの一覧と同じく、Google の連携の解除・データの削除の求め・退会ですぐ消す（第14.3.2節）。
-- 本人の直し（「このメールは〇〇の件」）は、次の振り分けに生かすため mail_watch.prefs に短く残す。

create table if not exists mail_categories (
  tenant_id   text not null references tenants(id) on delete cascade,
  user_id     text not null references users(id) on delete cascade,
  id          text not null,
  name        text not null,
  -- AI がまとめや振り分けに使う短い説明（何のまとまりか）
  note        text not null default '',
  -- 最後にこのカテゴリーのメールが動いた時刻（並べるのは最近 30 日に動きのあったものだけ）
  last_at     timestamptz not null default now(),
  -- 本人が「もう終わった」と言った（並べない。次にメールが来たらまた並べる）
  ended_at    timestamptz,
  -- このカテゴリーにしたスレッドの数（2 通以上になったら並べる。1 通だけの話題は並べない）
  seen        integer not null default 0,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, user_id, id)
);

alter table mail_categories enable row level security;
drop policy if exists tenant_isolation on mail_categories;
create policy tenant_isolation on mail_categories using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on mail_categories to m2office_app;

-- スレッドのカテゴリー（付けないこともある）
alter table mail_threads add column if not exists category_id text;
