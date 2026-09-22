-- 個人記憶（仕様書 第11.1・11.5.1節、ADR-0012）
-- 本人が「覚えておいて」と頼んだ一文だけを持つ。参照できるのは本人のみ。
-- 利用者を消すと、その人の記憶も消える（第11.6節）。
create table if not exists memories (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  user_id     text not null references users(id) on delete cascade,
  -- 覚えた一文。要約も推測もしない
  text        text not null,
  -- 覚えたきっかけ（secretary: 秘書への指示）
  source      text not null default 'secretary',
  created_at  timestamptz not null default now()
);
create index if not exists memories_user_idx on memories (tenant_id, user_id, created_at desc);

alter table memories enable row level security;
drop policy if exists tenant_isolation on memories;
create policy tenant_isolation on memories
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on memories to m2office_app;

-- 個人設定の区分 memory（覚えることを許すか、対象外の言葉。第6.5.4節）
alter table user_settings add column if not exists memory jsonb;
