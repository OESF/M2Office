-- 店頭サイネージの画面が、いつからつながっているか（仕様書 第31.5.1節。第 0.338.0 版）
--
-- 管理の画面で「接続中」の後ろに、つながってからの時間を出す。未接続（または登録した直後）のあとで
-- 最初に生きている知らせが来た時刻を持つ。最後の知らせの時刻（last_seen_at）とは別に持つ。
alter table signage_screens add column if not exists online_since timestamptz;
