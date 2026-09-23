-- 昇華（個人の記憶を組織知識へ。仕様書 第11.3.1節、ADR-0016）
-- 本人の提案または秘書の候補 → 本人の承認 → 管理者・承認者の判断 → 組織知識へ登録。
create table if not exists promotions (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  -- 記憶の持ち主（提案者）
  user_id       text not null references users(id) on delete cascade,
  memory_id     text references memories(id) on delete set null,
  -- 昇華する一文（記憶を消しても判断できるよう写しを持つ）
  text          text not null,
  -- proposed: 本人の判断待ち（秘書の候補） / pending: 組織の承認待ち
  -- approved: 登録済み / rejected: 却下 / withdrawn: 本人がやめた
  status        text not null,
  -- 組織の承認で登録した知識
  knowledge_id  text references knowledge_items(id) on delete set null,
  decided_by    text references users(id) on delete set null,
  comment       text,
  created_at    timestamptz not null default now(),
  decided_at    timestamptz
);
create index if not exists promotions_tenant_idx on promotions (tenant_id, status, created_at desc);
create index if not exists promotions_user_idx on promotions (tenant_id, user_id, created_at desc);

alter table promotions enable row level security;
drop policy if exists tenant_isolation on promotions;
create policy tenant_isolation on promotions
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on promotions to m2office_app;
