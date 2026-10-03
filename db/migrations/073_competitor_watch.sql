-- 競合の分析の段 2: 定期の見回り（仕様書 第36.19節。第 0.240.0 版）
-- 1. 回を見回った日（YYYY-MM-DD）にもできるようにする（毎週の見回りで比べるため。年月の回もそのまま読む）
alter table competitor_facts drop constraint if exists competitor_facts_period_check;
alter table competitor_facts add constraint competitor_facts_period_check check (period ~ '^\d{4}-\d{2}(-\d{2})?$');
alter table competitor_reports drop constraint if exists competitor_reports_period_check;
alter table competitor_reports add constraint competitor_reports_period_check check (period ~ '^\d{4}-\d{2}(-\d{2})?$');

-- 2. 読んだページの印（文字の指紋）。印が前の回と同じページは事実を取り出し直さない。ページの文字は残さない
create table if not exists competitor_pages (
  tenant_id      text not null references tenants(id) on delete cascade,
  -- 競合（自社なら空）
  competitor_id  text references competitors(id) on delete cascade,
  period         text not null check (period ~ '^\d{4}-\d{2}(-\d{2})?$'),
  url            text not null,
  hash           text not null,
  created_at     timestamptz not null default now()
);
create index if not exists competitor_pages_by on competitor_pages (tenant_id, competitor_id, period);

alter table competitor_pages enable row level security;
drop policy if exists tenant_isolation on competitor_pages;
create policy tenant_isolation on competitor_pages using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on competitor_pages to m2office_app;
