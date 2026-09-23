-- 会話ログ（仕様書 第11.9.4.1節、ADR-0014）
-- 秘書とのやり取りを 1 往復ずつ残す。読めるのは本人だけ（不変則 I-10）。逐語は 4 週で消す。
create table if not exists conversations (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  user_id      text not null references users(id) on delete cascade,
  -- 本人の依頼と、秘書の応答
  message      text not null,
  reply        text not null,
  -- 応答の層（direct / light / full。第10.9節）
  layer        text not null,
  -- 取り次いだ業務と、そこから始まった実行（評価はこの実行の承認から引く）
  agent_id     text,
  run_id       text references runs(id) on delete set null,
  -- 検索用に正規化した本文（全角英数を半角、英字を小文字）
  search_text  text not null,
  created_at   timestamptz not null default now()
);
create index if not exists conversations_user_idx on conversations (tenant_id, user_id, created_at desc);
create index if not exists conversations_rotate_idx on conversations (tenant_id, created_at);

alter table conversations enable row level security;
drop policy if exists tenant_isolation on conversations;
create policy tenant_isolation on conversations
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on conversations to m2office_app;
