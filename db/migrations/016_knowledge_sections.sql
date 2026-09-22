-- 組織知識の節（仕様書 第11.7.2節、ADR-0008）
-- 知識を保存するたびに、本文を章・条などの節に分けてここに入れ直す。検索と出典はこの単位で行う。
-- search_text は見出しの経路と本文を検索用に正規化したもの（全角英数を半角、英字を小文字）。
create table if not exists knowledge_sections (
  tenant_id    text not null references tenants(id) on delete cascade,
  item_id      text not null references knowledge_items(id) on delete cascade,
  ordinal      integer not null,
  heading      text not null,
  path         text[] not null default '{}',
  body         text not null,
  search_text  text not null,
  -- 文書の区画を写す。節ごとには指定しない（第11.7.2節）
  compartment  text,
  primary key (item_id, ordinal)
);
create index if not exists knowledge_sections_tenant_idx on knowledge_sections (tenant_id);

-- 版（保存のたびに 1 つ上げる）と、どの版の分け方で分けたか（分け方を変えたら分け直すため。第11.7.5節）
alter table knowledge_items add column if not exists version integer not null default 1;
alter table knowledge_items add column if not exists split_version integer not null default 0;

alter table knowledge_sections enable row level security;
drop policy if exists tenant_isolation on knowledge_sections;
create policy tenant_isolation on knowledge_sections
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on knowledge_sections to m2office_app;
