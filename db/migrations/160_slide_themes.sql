-- Google スライドのテーマ（仕様書 第9.4.2節「Google スライドのテーマを使う・PowerPoint の取り出し」、Q-265、ADR-0109）。
-- 本人が Google のファイルを選ぶ画面で選んだプレゼンテーション（ギャラリーから作ったものなど）を、テーマとして覚える。
-- user_id が null のものは会社のテーマ（管理者が登録。会社の人がみな選べる）。見本に出す 1 枚目の縮小の絵を持つ。
-- 作ったスライドがどのテーマで作られたか（作り直しで同じテーマを使うため）を slide_decks.theme_id に持つ。
-- 巻き戻し: 作ったスライドの列と表を消す（ほかの表から参照されるのは作ったスライドの列だけ）。

create table if not exists slide_themes (
  id               text primary key,
  tenant_id        text not null references tenants(id) on delete cascade,
  user_id          text references users(id) on delete cascade,
  presentation_id  text not null,
  name             text not null,
  thumbnail        bytea,
  thumbnail_mime   text check (thumbnail_mime is null or thumbnail_mime in ('image/png', 'image/jpeg')),
  created_at       timestamptz not null default now()
);
create index if not exists slide_themes_tenant on slide_themes (tenant_id, created_at desc);

alter table slide_themes enable row level security;
drop policy if exists tenant_isolation on slide_themes;
create policy tenant_isolation on slide_themes using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on slide_themes to m2office_app;

alter table slide_decks add column if not exists theme_id text references slide_themes(id) on delete set null;
