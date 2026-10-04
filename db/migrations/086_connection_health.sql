-- 接続先の健全性（仕様書 第6.7.6節。第 0.255.0 版）
-- 会社ごと・接続ごとに、1 分単位で呼び出しの回数・失敗の数・合計の時間・最後の失敗の種類だけを足し込む。
-- 依頼や応答の中身と、誰の呼び出しかは持たない。2 日を過ぎた行は消す
create table if not exists connection_health (
  tenant_id   text not null references tenants(id) on delete cascade,
  -- 'ai'・'google:gmail'・'mcp:<接続の ID>' など
  target      text not null,
  minute      timestamptz not null,
  ok          integer not null default 0,
  fail        integer not null default 0,
  total_ms    bigint not null default 0,
  -- 最後の失敗の種類（'busy'・'unreachable' など。文は持たない）
  last_error  text,
  primary key (tenant_id, target, minute)
);

alter table connection_health enable row level security;
drop policy if exists tenant_isolation on connection_health;
create policy tenant_isolation on connection_health
  using (tenant_id = m2o_current_tenant())
  with check (tenant_id = m2o_current_tenant());

grant select, insert, update, delete on connection_health to m2office_app;
