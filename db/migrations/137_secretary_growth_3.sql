-- 秘書の成長の段 3（仕様書 第11.13.5節・第11.13.6節。第 0.365.0 版。ADR-0095）
--
-- ① 案件ノート: 本人ごとに、進んでいる案件の状態・次にやること・期限を秘書が 1 日 1 回書き足す。本人だけのもの。
-- ② 会社の知識の確かさ: 秘書が学んだことを、何人の秘書が同じく学んだか。
-- ③ 答えられなかった問い: 誰が聞いたかを残さずに残し、答えが知識に入ったら印を付ける。90 日で消す。
create table if not exists case_notes (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  user_id     text not null,
  title       text not null check (char_length(title) between 1 and 40),
  state       text not null default '' check (char_length(state) <= 300),
  next_step   text not null default '' check (char_length(next_step) <= 200),
  due_on      date,
  status      text not null default 'open' check (status in ('open', 'closed')),
  last_day    date not null,
  closed_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists case_notes_owner_idx on case_notes (tenant_id, user_id, status, last_day desc);

-- 本人ごとに、最後に案件ノートを作った時刻（1 日 1 回にするため）
create table if not exists case_note_runs (
  tenant_id   text not null references tenants(id) on delete cascade,
  user_id     text not null,
  ran_at      timestamptz not null,
  primary key (tenant_id, user_id)
);

alter table knowledge_items add column if not exists confirmations integer not null default 1;

create table if not exists knowledge_gaps (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  question      text not null check (char_length(question) between 1 and 200),
  source        text not null check (source in ('secretary', 'knowledge-qa')),
  created_at    timestamptz not null default now(),
  answered_at   timestamptz,
  knowledge_id  text
);
create index if not exists knowledge_gaps_tenant_idx on knowledge_gaps (tenant_id, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['case_notes', 'case_note_runs', 'knowledge_gaps'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
    execute format('grant select, insert, update, delete on %I to m2office_app', t);
  end loop;
end $$;
