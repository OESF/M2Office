-- 秘書の作業の記憶（仕様書 第10.7.4節。第 0.584.0 版。ADR-0147）。
-- やり取りごとに、話に出たもの（見つけたメール・資料・作ったもの・頼んだ業務・開いていた 1 件）を、種類・題名・ID・リンクで持つ。
-- 道具の結果と画面の操作から決まりで拾う（推論の文からは作らない）。会話ログと同じく 4 週で消え、本人が会話ログを消せば一緒に消える。
-- 1 週間分のやり取りは、いまの索引（conversations_user_idx）で期間を引く。
--
-- 巻き戻し: 前の版に戻しても動く（足した列は読まれない）。消すなら
--   alter table conversations drop column mentions;

alter table conversations add column if not exists mentions jsonb not null default '[]'::jsonb;
