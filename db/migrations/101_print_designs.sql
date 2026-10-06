-- 販促物の作成（内蔵の拡張。仕様書 第41章。第 0.290.0 版）。
-- ポップ・チラシ・パンフレット・案内・ポスター・ショップカードの物と、その版（3 案も版）を会社ごとに持つ。
-- 画像と案の小さな画像はファイルの置き場（キー `print-<版の ID>-image`・`print-<版の ID>-preview`）に置き、表には持たない。

alter table tenant_settings add column if not exists print_designs jsonb;

create table if not exists print_designs (
  id                  text primary key,
  tenant_id           text not null references tenants(id) on delete cascade,
  title               text not null,
  kind                text not null check (kind in ('pop', 'flyer', 'brochure', 'notice', 'poster', 'card')),
  size                text not null,
  current_version_id  text,
  post_from           date,
  post_to             date,
  place               text not null default '',
  removed_at          timestamptz,
  ended_notified      boolean not null default false,
  request             text not null default '',
  remade_from         text,
  created_by          text not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists print_designs_tenant on print_designs (tenant_id, updated_at desc);

create table if not exists print_design_versions (
  id              text primary key,
  tenant_id       text not null references tenants(id) on delete cascade,
  design_id       text not null references print_designs(id) on delete cascade,
  no              integer not null,
  proposal        boolean not null default false,
  template        text not null,
  palette         integer not null default 0,
  color           text not null,
  headline_scale  real not null default 1,
  copy            jsonb not null,
  image           text not null default 'none' check (image in ('none', 'ai', 'photo')),
  ai_image        boolean not null default false,
  checks          jsonb not null default '[]',
  instruction     text not null default '',
  created_by      text not null,
  created_at      timestamptz not null default now(),
  unique (design_id, no)
);
create index if not exists print_design_versions_design on print_design_versions (tenant_id, design_id, no);

alter table print_designs enable row level security;
drop policy if exists tenant_isolation on print_designs;
create policy tenant_isolation on print_designs
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on print_designs to m2office_app;

alter table print_design_versions enable row level security;
drop policy if exists tenant_isolation on print_design_versions;
create policy tenant_isolation on print_design_versions
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on print_design_versions to m2office_app;
