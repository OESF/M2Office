-- グループの名前で共有を頼めるようにする（仕様書 第16.7.12.1節。第 0.295.0 版、ADR-0076）。
-- グループに合う Google Chat のスペースを、秘書が見つけたら覚える（会社で共有。会話で直せる）。
-- 中身は { space: 'spaces/…', name: 表示名, by: 見つけ方（name・members・told）, at: 日時 }。

alter table user_groups add column if not exists chat_space jsonb;
