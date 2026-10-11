-- 不正の兆しの見張りの動いている様子（仕様書 第16.8.3節・第6.7.4.2.2節。第 0.333.0 版）
--
-- ワーカーが見回るたびに、会社ごとに最後に見回った時刻を 1 行だけ持つ（ダッシュボードの「見張り中」と、止まっていることを示すため）。

create table if not exists security_watch_state (
  tenant_id     text primary key references tenants(id) on delete cascade,
  last_scan_at  timestamptz not null
);

alter table security_watch_state enable row level security;
drop policy if exists tenant_isolation on security_watch_state;
create policy tenant_isolation on security_watch_state using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on security_watch_state to m2office_app;
