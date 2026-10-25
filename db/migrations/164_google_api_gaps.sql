-- 有効になっていない Google の API（仕様書 第6.6.2節「足りない API を知らせる」、Q-269）。
-- 業務が Google から「API が有効になっていません」と断られたら、会社ごとにどの API かを覚え、管理者ページの「状態」に出す。
-- 残すのは API の名前と日時だけ（人の名前やデータの中身は残さない）。その API の呼び出しが成功したら消す。
-- 巻き戻し: 表を消す（ほかの表から参照されない）。

create table if not exists google_api_gaps (
  tenant_id     text not null references tenants(id) on delete cascade,
  service       text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  notified_at   timestamptz,
  primary key (tenant_id, service)
);

alter table google_api_gaps enable row level security;
drop policy if exists tenant_isolation on google_api_gaps;
create policy tenant_isolation on google_api_gaps using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on google_api_gaps to m2office_app;
