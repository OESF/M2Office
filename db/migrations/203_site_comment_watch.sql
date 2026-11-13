-- サイトの更新の段 2b: 承認待ちのコメントの見回り（仕様書 第45.18.3節。第 0.576.0 版）
--
-- 会社ごとに、前に知らせたコメントの番号を持つ（その後に来た承認待ちのコメントだけを知らせる）。コメントの名前と文は写さない。
-- 巻き戻し: 表を落とす（前の版はこの表を読まない）。

create table if not exists site_comment_watch (
  tenant_id        text primary key references tenants(id) on delete cascade,
  last_comment_id  bigint not null default 0,
  checked_at       timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['site_comment_watch'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
    execute format('grant select, insert, update, delete on %I to m2office_app', t);
  end loop;
end $$;
