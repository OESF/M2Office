-- 依頼のときの業務の名前（仕様書 第6.2.5節）。
-- 業務を削除した後も、承認トレイの「判断したもの」や実行の一覧に名前を出すため。ID をそのまま出さない
alter table jobs add column if not exists agent_name text;
