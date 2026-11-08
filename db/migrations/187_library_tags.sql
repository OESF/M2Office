-- ナレッジの整理（仕様書 第44章）のタグ（第44.17.3節。第 0.535.0 版、ADR-0128）と、確かめた記録（第44.16.1節、ADR-0129）。
-- AI が、取引先・案件・製品・技術・分野・書類の種類など、探す手がかりになるキーを区別せず同列のタグとして付ける。
-- tagged はタグを付け終えたか。もう入っている資料は false のまま入り、ワーカーが保存した項目だけから付け直す。
--
-- 巻き戻し: 前の版に戻しても動く（足した列は読まれない）。消すなら
--   drop index if exists library_items_untagged;
--   drop index if exists library_items_tags;
--   alter table library_items drop column tagged, drop column tags, drop column viewed_at;
--   alter table library_owner_state drop column views_checked_at;

alter table library_items add column if not exists tags text[] not null default '{}';
alter table library_items add column if not exists tagged boolean not null default false;

-- 開発の環境で、この版の途中の形（案件 projects・テーマ topics の列）を入れていたら、タグに移して付け直しに戻す（本番には出していない）
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'library_items' and column_name = 'projects') then
    update library_items
       set tags = (select coalesce(array_agg(distinct t), '{}') from unnest(projects || topics || array[counterparty]) as t where t <> ''),
           edited = array(select case when e in ('projects', 'topics') then 'tags' else e end from unnest(edited) as e group by 1),
           tagged = false;
    drop index if exists library_items_untagged;
    alter table library_items drop column projects, drop column topics;
  end if;
end $$;

-- 本人が実際の資料を開いた時刻（OKF の verified に書く。第44.16.1節、ADR-0129）と、開いた時刻を最後にドライブから読んだ時刻
alter table library_items add column if not exists viewed_at timestamptz;
alter table library_owner_state add column if not exists views_checked_at timestamptz;

-- 付け直しを待つ資料（読み取りを待っているものは、読んだときに付ける）
create index if not exists library_items_untagged on library_items (tenant_id, owner_id) where not tagged and read_state not in ('pending', 'paused');
-- タグで絞り込む
create index if not exists library_items_tags on library_items using gin (tags);
