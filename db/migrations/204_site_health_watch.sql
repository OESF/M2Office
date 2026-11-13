-- サイトの更新の段 3: プラグイン・テーマ・本体の状態の見回り（仕様書 第45.18.5節。第 0.577.0 版）
--
-- 会社ごとに、前に知らせた問題の指紋と、見回った時刻を持つ（同じ問題を毎週くり返し知らせない）。プラグインの名前などは写さない。
-- 巻き戻し: 列を落とす（前の版はこの列を読まない）。

alter table site_comment_watch add column if not exists health_digest text not null default '';
alter table site_comment_watch add column if not exists health_checked_at timestamptz;
