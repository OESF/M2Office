-- 作ったスライド（仕様書 第9.4.2節「作ったスライドの扱い」、Q-264、ADR-0108）。
-- 作った人ごとに、ファイルの ID・題名・デザイン・共有の範囲・頼み・構成（作り直すため）を持つ。
-- 構成は調べた結果から作った資料の中身であり、スライドそのものと同じ扱い。削除と、利用者の削除で消す。
-- 成果物から作ったスライドを引けるよう、成果物に slide_deck_id を足す。
-- 巻き戻し: 成果物の列と表を消す（ほかの表から参照されるのは成果物の列だけ）。

create table if not exists slide_decks (
  id               text primary key,
  tenant_id        text not null references tenants(id) on delete cascade,
  user_id          text not null references users(id) on delete cascade,
  presentation_id  text not null,
  title            text not null,
  design           text,
  template         text,
  sharing          text not null default 'private' check (sharing in ('private', 'company')),
  request          text not null default '',
  plan             jsonb not null,
  image_prompts    jsonb not null default '{}'::jsonb,
  run_id           text,
  built_at         timestamptz not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists slide_decks_user on slide_decks (tenant_id, user_id, updated_at desc);
create index if not exists slide_decks_shared on slide_decks (tenant_id, updated_at desc) where sharing = 'company';

alter table slide_decks enable row level security;
drop policy if exists tenant_isolation on slide_decks;
create policy tenant_isolation on slide_decks using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on slide_decks to m2office_app;

alter table artifacts add column if not exists slide_deck_id text references slide_decks(id) on delete set null;
