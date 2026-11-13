-- 会社の見た目（仕様書 第46章、ADR-0145。第 0.579.0 版）
--
-- 会社ごとに、見た目の決まり（色・文字・形・写真と絵の雰囲気・文の調子）を版で持つ。いちばん新しい版が、いまの見た目。
-- 直近の 20 版を残し、前の版に戻せる。テナントで絞る（不変則 I-2）。
-- 巻き戻し: 表を落とす（前の版はこの表を読まない）。

create table if not exists company_designs (
  tenant_id    text not null references tenants(id) on delete cascade,
  version      integer not null,
  tokens       jsonb not null,
  summary      text not null default '',
  source       text not null check (source in ('ai', 'import', 'chat', 'restore')),
  source_name  text not null default '',
  created_by   text not null,
  created_at   timestamptz not null default now(),
  primary key (tenant_id, version)
);

do $$
declare t text;
begin
  foreach t in array array['company_designs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
    execute format('grant select, insert, update, delete on %I to m2office_app', t);
  end loop;
end $$;
