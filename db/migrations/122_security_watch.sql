-- 不正の兆しの見張り（仕様書 第16.8節、ADR-0091。第 0.332.0 版）
--
-- 見つけた兆し（同じ兆しを二度知らせないため。秘書が「セキュリティの知らせは？」に答えるため）と、
-- 管理者が「これは大丈夫」と言った兆しの型（同じ人・同じ型を 30 日知らせない）。
-- 中身（開いた記録・業務の中身・場所）は持たない。兆しの型・重さ・対象の人・数だけを持つ。

create table if not exists security_signals (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  -- 兆しの型（export・export_burst・bulk_mail・login_disabled・session_disabled・login_burst・login_flood・admin_added・permission_burst・new_device・auto_signout）
  type        text not null,
  severity    text not null check (severity in ('high', 'medium')),
  -- 対象の人（分からなければ null。ログインの拒否はメールアドレスを key に持つ）
  user_id     text,
  -- 二度知らせないための鍵（監査ログの ID・型と人と時間の窓など）
  key         text not null,
  -- 数・時間の帯など（中身は入れない）
  detail      jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  unique (tenant_id, type, key)
);
create index if not exists security_signals_recent_idx on security_signals (tenant_id, created_at desc);

create table if not exists security_suppressions (
  tenant_id   text not null references tenants(id) on delete cascade,
  user_id     text not null,
  type        text not null,
  until       timestamptz not null,
  created_by  text not null,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, user_id, type)
);

do $$ declare t text; begin
  foreach t in array array['security_signals', 'security_suppressions'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
  end loop; end $$;

grant select, insert, update, delete on security_signals, security_suppressions to m2office_app;
