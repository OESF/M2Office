-- 対話からの学習（仕様書 第11.5.2節、ADR-0015）
-- 1 日 1 回、前日の会話から「その日の要約」と「記憶の候補」を作る。
-- 候補は本人が採ったときだけ記憶（memories）になる。
create table if not exists memory_candidates (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  user_id      text not null references users(id) on delete cascade,
  text         text not null,
  -- pending: 本人の判断待ち / dismissed: 不要（同じ文を再び候補にしないために残す）
  status       text not null default 'pending',
  -- 元にした日（日本時間の YYYY-MM-DD）
  source_day   text not null,
  created_at   timestamptz not null default now()
);
create index if not exists memory_candidates_user_idx
  on memory_candidates (tenant_id, user_id, status, created_at desc);

-- 会話の要約（長期に持つ。逐語が 4 週で消えた後も残る。第11.9.6節）
create table if not exists conversation_digests (
  tenant_id    text not null references tenants(id) on delete cascade,
  user_id      text not null references users(id) on delete cascade,
  -- 日本時間の YYYY-MM-DD
  day          text not null,
  summary      text not null,
  -- 権限区画の印（区画のデータを含む会話の要約に引き継ぐ。第11.9.6節 注意点 2）
  compartment  text,
  created_at   timestamptz not null default now(),
  primary key (tenant_id, user_id, day)
);

alter table memory_candidates enable row level security;
drop policy if exists tenant_isolation on memory_candidates;
create policy tenant_isolation on memory_candidates
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on memory_candidates to m2office_app;

alter table conversation_digests enable row level security;
drop policy if exists tenant_isolation on conversation_digests;
create policy tenant_isolation on conversation_digests
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on conversation_digests to m2office_app;
