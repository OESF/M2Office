-- 調べものの結果を伝えたことの記録（仕様書 第10.11.7節「持ち越し」）
--
-- 画面と音声の両方から伝えうるため、覚えをどちらか一方に置くと二度伝えてしまう。
-- 記録は**先に取ってから伝える**。取れた側だけが伝えるため、
-- 画面と音声を同時に開いていても、伝えるのは一方だけになる。
--
-- 実行が消えれば、この記録も一緒に消える（伝える相手がいなくなるため）。
create table if not exists lookup_deliveries (
  tenant_id  text not null references tenants(id) on delete cascade,
  run_id     text not null references runs(id) on delete cascade,
  told_at    timestamptz not null default now(),
  primary key (tenant_id, run_id)
);

alter table lookup_deliveries enable row level security;
drop policy if exists tenant_isolation on lookup_deliveries;
create policy tenant_isolation on lookup_deliveries
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, delete on lookup_deliveries to m2office_app;
