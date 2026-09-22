-- 通知を Chat とメールへ届ける（仕様書 第6.5.5.2節、ADR-0011）
-- 画面内のお知らせを正とし、Chat とメールはその控え。1 つの通知につき 1 回だけ送る。
-- delivered_at は送り終えた時刻（送る先が無いときも、見回りの対象から外すために入れる）。
-- delivery_note は届け先と、送れなかったときの理由。
alter table notifications add column if not exists delivered_at timestamptz;
alter table notifications add column if not exists delivery_note text;
create index if not exists notifications_delivery_idx
  on notifications (tenant_id, created_at) where delivered_at is null;
