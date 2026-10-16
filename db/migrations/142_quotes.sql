-- AG-07 見積書作成（仕様書 第9.5.8節。第 0.379.0 版。ADR-0103）
--
-- 作った見積書の記録。見積番号の連番・同じ品目の前の単価の既定・「〇〇社に出した見積は？」に答えるために持つ。
-- 金額は数量×単価から決まった計算で出したもの（推論に計算させない）。見積書は金額を示す書類で、お金の確定ではない。
create table if not exists quotes (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  number        text not null,
  requested_by  text not null,
  run_id        text,
  to_name       text not null default '',
  items         jsonb not null default '[]',
  subtotal      bigint not null default 0,
  tax           bigint not null default 0,
  total         bigint not null default 0,
  valid_until   date,
  file_id       text,
  created_at    timestamptz not null default now(),
  unique (tenant_id, number)
);
create index if not exists quotes_tenant_idx on quotes (tenant_id, created_at desc);

alter table quotes enable row level security;
drop policy if exists tenant_isolation on quotes;
create policy tenant_isolation on quotes using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on quotes to m2office_app;
