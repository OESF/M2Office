-- 受注を手で入れる（仕様書 第42.5.1.1節、Q-274）。電話などで受けた注文を、画面か秘書から入れる。
-- 入り口に「手で入れた」（manual）を足す。
-- 巻き戻し: manual の受注の入り口を upload に直してから、制約を元の 4 つに戻す。

alter table sales_orders drop constraint if exists sales_orders_source_check;
alter table sales_orders add constraint sales_orders_source_check check (source in ('upload', 'secretary', 'mail', 'quote', 'manual'));
