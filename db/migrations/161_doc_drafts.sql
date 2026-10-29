-- 作った文書（業務「文書の作成」。仕様書 第9.5.5.2節「文書の作成の扱い」、Q-266）。
-- 作ったスライド（移行 159）と同じ置き場を、種類（slides・doc）で分けて使う。文書は構成（plan）の代わりに本文（Markdown）を持つ。
-- 巻き戻し: 種類が doc の行を消してから、列を消し、plan を not null に戻す。

alter table slide_decks add column if not exists kind text not null default 'slides';
alter table slide_decks drop constraint if exists slide_decks_kind_check;
alter table slide_decks add constraint slide_decks_kind_check check (kind in ('slides', 'doc')) not valid;  -- 移行は毎回すべて流すため、後で足した種類の行があっても止まらないよう、ここでは確かめない（最後の形は移行 163）
alter table slide_decks add column if not exists body text;
alter table slide_decks alter column plan drop not null;
create index if not exists slide_decks_kind on slide_decks (tenant_id, kind, user_id, updated_at desc);
