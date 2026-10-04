-- Webの分析: 依頼文を承認の後に送る（仕様書 第34.21節。第 0.249.0 版）
-- 直すべき所に、制作会社に依頼文を送った日時を残す（宛先は会社の設定 webReview.agency）
alter table web_review_findings add column if not exists request_sent_at timestamptz;
