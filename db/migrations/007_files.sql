-- ファイル（仕様書 第9.4.1節 文書を扱う共通ツール）
-- 中身はファイルの置き場（開発はローカル、本番はオブジェクトストレージ）に置き、ここにはメタデータだけを持つ。
create table if not exists files (
  id             text primary key,
  tenant_id      text not null references tenants(id) on delete cascade,
  owner_user_id  text not null references users(id) on delete cascade,
  name           text not null,
  kind           text not null,          -- pdf / xlsx / csv / docx / png / jpeg
  mime           text not null,
  size           integer not null,
  sha256         text not null,
  origin         text not null,          -- upload（利用者が上げた）/ generated（業務が作った）
  run_id         text references runs(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists files_owner_idx on files (tenant_id, owner_user_id, created_at desc);

alter table files enable row level security;
drop policy if exists tenant_isolation on files;
create policy tenant_isolation on files
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert on files to m2office_app;

-- 成果物がファイルである場合の参照
alter table artifacts add column if not exists file_id text references files(id) on delete set null;
