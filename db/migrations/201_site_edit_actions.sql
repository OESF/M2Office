-- サイトの更新の段 2a（仕様書 第45.18.1節、ADR-0143。第 0.570.0 版）
--
-- 直しの 1 件に、新しい記事と固定ページを作る・公開の状態を変える・前の版に戻す・アイキャッチを付ける、を並べる。
-- ページの直し（pages）と同じく、90 日を過ぎたら本文と題名を消して記録だけを残す。

alter table site_edits add column if not exists actions jsonb not null default '[]'::jsonb;
