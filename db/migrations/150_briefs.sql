-- 朝のブリーフ・週次ブリーフの本文（仕様書 第9.5.5.1.2節。第 0.405.0 版。Q-246）
--
-- ブリーフの本文は、本人が受け取る成果物として実行の記録と同じ期間残す（第14.3.2節の「成果物」）。
-- 集めた段の中身（予定・メールなど Google から取ったもの）は、いままでどおり実行が終わってから 7 日で消す。
-- 見られるのは本人だけ。Google の連携の解除・データの削除の求めで、その人の行を消す。利用者を消せば行も消える。
create table if not exists briefs (
  run_id      text primary key references runs(id) on delete cascade,
  tenant_id   text not null references tenants(id) on delete cascade,
  user_id     text not null references users(id) on delete cascade,
  agent_id    text not null,
  title       text not null,
  body        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists briefs_user_agent_idx on briefs (tenant_id, user_id, agent_id, created_at desc);

alter table briefs enable row level security;
drop policy if exists tenant_isolation on briefs;
create policy tenant_isolation on briefs using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on briefs to m2office_app;
