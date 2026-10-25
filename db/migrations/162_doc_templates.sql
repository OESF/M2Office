-- 文書のテンプレート（Google ドキュメントのテンプレート ギャラリー。仕様書 第9.5.5.2節「文書のテンプレート」、Q-267、ADR-0110）。
-- Google スライドのテーマ（移行 160）と同じ置き場を、種類（slides・doc）で分けて使う。
-- 作った文書がどのテンプレートで作られたかは slide_decks.theme_id に持つ（作り直しで同じテンプレートを使う）。
-- 巻き戻し: 種類が doc の行を消してから、列を消す。

alter table slide_themes add column if not exists kind text not null default 'slides';
alter table slide_themes drop constraint if exists slide_themes_kind_check;
alter table slide_themes add constraint slide_themes_kind_check check (kind in ('slides', 'doc'));
create index if not exists slide_themes_kind on slide_themes (tenant_id, kind, created_at desc);
