-- ヘルプの会社の補足（仕様書 第6.10.7節。第 0.286.0 版）。管理者が、ヘルプの記事（業務の説明を含む）ごとに社内向けの補足を書く。
-- 業務の説明・ヘルプセンターの記事・秘書の使い方の答えに添えて出す。会社ごと（行単位の制限）。

create table if not exists help_notes (
  tenant_id   text not null references tenants(id) on delete cascade,
  article_id  text not null check (char_length(article_id) between 1 and 120),
  text        text not null check (char_length(text) between 1 and 1000),
  updated_by  text not null,
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, article_id)
);

alter table help_notes enable row level security;
drop policy if exists tenant_isolation on help_notes;
create policy tenant_isolation on help_notes
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on help_notes to m2office_app;
