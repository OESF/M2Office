-- サイトの更新（内蔵の拡張。仕様書 第45章、ADR-0140。第 0.564.0 版）
--
-- 1. 会社の設定の区分（入り切りと、管理者の承認を加えるか）。既定は切り（Q-330）。
-- 2. 直しの記録。1 回の頼みで 1 行。ページごとの直す前と後の本文は pages に持ち、90 日を過ぎたら消して、
--    いつ・誰が・どのページを直したかだけを残す（Q-332。purged_at）。テナントで絞る（不変則 I-2）。

alter table tenant_settings add column if not exists site_updates jsonb;

create table if not exists site_edits (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  requested_by  text not null,
  request       text not null default '',
  status        text not null check (status in ('awaiting', 'applied', 'partial', 'failed', 'rejected', 'reverted')),
  -- 元に戻す直しなら、戻した直しの ID
  revert_of     text,
  -- 承認の後に入れる実行（付属の業務「サイトに入れる」）
  run_id        text,
  -- ページごとの直す前と後・結果（第45.11節）
  pages         jsonb not null default '[]'::jsonb,
  -- 承認した中身の指紋（承認の後に中身が変わっていたら入れない）
  digest        text not null default '',
  created_at    timestamptz not null default now(),
  applied_at    timestamptz,
  reverted_at   timestamptz,
  purged_at     timestamptz
);
create index if not exists site_edits_tenant on site_edits (tenant_id, created_at desc);
create index if not exists site_edits_purge on site_edits (created_at) where purged_at is null;

do $$
declare t text;
begin
  foreach t in array array['site_edits'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
    execute format('grant select, insert, update, delete on %I to m2office_app', t);
  end loop;
end $$;
