-- サイトの更新の、サイトのカテゴリーとタグの直し（仕様書 第45.17節、ADR-0142。第 0.568.0 版）
--
-- 直しの 1 件に、カテゴリー・タグを作る・名前を変える・記事に付ける／外す（元に戻すときは消すも）を並べる。
-- ページの直し（pages）と同じく、90 日を過ぎたら名前などを消して記録だけを残す。

alter table site_edits add column if not exists terms jsonb not null default '[]'::jsonb;
