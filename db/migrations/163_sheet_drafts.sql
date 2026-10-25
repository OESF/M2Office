-- 作った表と表のテンプレート（業務「表の作成」。仕様書 第9.5.5.2節「表の作成の扱いとテンプレート」、Q-268、ADR-0111）。
-- 作ったスライド・文書と同じ置き場（slide_decks）と、テーマ・文書のテンプレートと同じ置き場（slide_themes）を、種類 sheet で分けて使う。
-- 表は作り直すため、列と行（table_data）を持つ。
-- 巻き戻し: 種類が sheet の行を消してから、列を消し、種類の決まりを slides・doc に戻す。

alter table slide_decks drop constraint if exists slide_decks_kind_check;
alter table slide_decks add constraint slide_decks_kind_check check (kind in ('slides', 'doc', 'sheet'));
alter table slide_decks add column if not exists table_data jsonb;
alter table slide_themes drop constraint if exists slide_themes_kind_check;
alter table slide_themes add constraint slide_themes_kind_check check (kind in ('slides', 'doc', 'sheet'));
