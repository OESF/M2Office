-- 直しから学び、直しを数える（仕様書 第11.13.7節、ADR-0134。第 0.550.0 版。秘書の成長 段 4）
--
-- 会話での訂正・作り直しの頼み・承認の差し戻し・取り次ぎの頼み直しを「直し」として受け取り、
-- 次からもそうしてほしい直しを、業務ごとの好みとして覚える。取り次ぎの頼み直しは、取り次ぎの好み（種類 routing）として覚える。
-- 直しの数は、本人ごと・週ごと・種類ごとに数えるだけで、直しの文そのものは残さない（好みとして覚えた文だけが残る）。

-- 好みに、どの業務の好みかを持たせる（無ければ業務を決めない好み）。取り次ぎの好みを足す
alter table memories add column if not exists agent_id text;
alter table memories drop constraint if exists memories_kind_check;
alter table memories add constraint memories_kind_check check (kind in ('fact', 'preference', 'routing'));

-- 週ごとの直しの数（種類: conversation・remake・reject・reroute）と、頼んだ数（requests）。メールの直しと外れは mail_learning_weeks にある
create table if not exists learning_weeks (
  tenant_id  text not null references tenants(id) on delete cascade,
  user_id    text not null references users(id) on delete cascade,
  -- その週の月曜日（日本時間）
  week       date not null,
  kind       text not null,
  count      integer not null default 0,
  primary key (tenant_id, user_id, week, kind)
);

alter table learning_weeks enable row level security;
drop policy if exists tenant_isolation on learning_weeks;
create policy tenant_isolation on learning_weeks using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on learning_weeks to m2office_app;

-- 取り消しと頼み直しの数（同じ言い方で 2 回そろったら、取り次ぎの好みとして覚える。そろったら消す）
create table if not exists secretary_reroutes (
  tenant_id   text not null references tenants(id) on delete cascade,
  user_id     text not null references users(id) on delete cascade,
  -- 言い方を比べる形（大小・空白・記号を除いたもの）
  phrase_key  text not null,
  phrase      text not null,
  agent_id    text not null,
  hits        integer not null default 0,
  last_at     timestamptz not null default now(),
  primary key (tenant_id, user_id, phrase_key, agent_id)
);

alter table secretary_reroutes enable row level security;
drop policy if exists tenant_isolation on secretary_reroutes;
create policy tenant_isolation on secretary_reroutes using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on secretary_reroutes to m2office_app;

-- 運営: 本人が共有を頼んだ人の、週ごとの直しの数（種類ごと）と頼んだ数（ベータテスト。第11.13.7節「見せ方」）。
-- メールの直しと外れ（mail_learning_weeks）は、種類 mail として足す。名前・メールアドレス・直しの文は返さない
create or replace function ops.learning_shared()
  returns table (tenant_id text, person text, week date, kind text, count integer)
  language sql stable security definer set search_path = pg_catalog, public as $$
  with shared as (
    select w.tenant_id, w.user_id from mail_watch w where (w.prefs ->> 'shareLearning') = 'true'
  ), rows as (
    select l.tenant_id, l.user_id, l.week, l.kind, l.count from learning_weeks l
    union all
    select m.tenant_id, m.user_id, m.week, 'mail', m.corrections + m.misses from mail_learning_weeks m
  )
  select r.tenant_id, substr(md5(r.tenant_id || ':' || r.user_id), 1, 8), r.week, r.kind, r.count
    from rows r join shared s on s.tenant_id = r.tenant_id and s.user_id = r.user_id
   where r.week >= (current_date - 84)
   order by r.tenant_id, 2, r.week, r.kind;
$$;
revoke all on function ops.learning_shared() from public;
grant execute on function ops.learning_shared() to m2office_ops;
