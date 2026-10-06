-- 販促物の作成の段 2 のつなぎ（仕様書 第41.18節。第 0.291.0 版）。
-- 種類に値札（tags）を足し、店頭サイネージに流している様子（状態・素材・画面の名前・日時）を物に持つ。

alter table print_designs drop constraint if exists print_designs_kind_check;
alter table print_designs add constraint print_designs_kind_check check (kind in ('pop', 'flyer', 'brochure', 'notice', 'poster', 'card', 'tags'));

alter table print_designs add column if not exists signage_state text not null default 'none' check (signage_state in ('none', 'waiting', 'on'));
alter table print_designs add column if not exists signage_asset_id text;
alter table print_designs add column if not exists signage_screens jsonb not null default '[]'::jsonb;
alter table print_designs add column if not exists signage_at timestamptz;
