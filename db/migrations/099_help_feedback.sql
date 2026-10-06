-- ヘルプを育てる（仕様書 第6.10.10節。第 0.285.0 版）。秘書がヘルプに見当たらなかった使い方の質問と、記事が役に立ったかを持つ。
-- 見つからなかった質問には、質問した人を持たない（管理者に件数と質問の文だけを示すため）。90 日で消す。
-- 役に立ったかは、1 人が 1 つの記事に 1 つ（直せる）。管理者には件数だけを示す。

create table if not exists help_misses (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  question    text not null check (char_length(question) between 1 and 200),
  created_at  timestamptz not null default now()
);
create index if not exists help_misses_tenant on help_misses (tenant_id, created_at desc);

alter table help_misses enable row level security;
drop policy if exists tenant_isolation on help_misses;
create policy tenant_isolation on help_misses
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, delete on help_misses to m2office_app;

create table if not exists help_ratings (
  tenant_id   text not null references tenants(id) on delete cascade,
  user_id     text not null,
  article_id  text not null check (char_length(article_id) between 1 and 120),
  source      text not null check (source in ('article', 'secretary')),
  helpful     boolean not null,
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, user_id, article_id, source)
);

alter table help_ratings enable row level security;
drop policy if exists tenant_isolation on help_ratings;
create policy tenant_isolation on help_ratings
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on help_ratings to m2office_app;
