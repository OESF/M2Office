-- 効果のレポート（仕様書 第6.7.13節。第 0.362.0 版）
--
-- 月ごとに、推計の削減時間と AI の費用の数字（プログラムが計算）と、AI が書いた文を残す。会社と月で 1 つ（作り直すと置き換える）。
-- 25 か月を過ぎたものはワーカーが消す。
create table if not exists effect_reports (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  month       text not null check (month ~ '^\d{4}-\d{2}$'),
  kind        text not null check (kind in ('monthly', 'manual')),
  figures     jsonb not null,
  body        jsonb not null,
  created_by  text,
  created_at  timestamptz not null default now(),
  unique (tenant_id, month)
);
create index if not exists effect_reports_tenant_idx on effect_reports (tenant_id, month desc);

alter table effect_reports enable row level security;
drop policy if exists tenant_isolation on effect_reports;
create policy tenant_isolation on effect_reports using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on effect_reports to m2office_app;
