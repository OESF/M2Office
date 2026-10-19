-- 仕入価格と、仕入れの相場（仕様書 第29.6.2節。第 0.400.0 版。Q-244）
--
-- 品目に仕入価格（使う単位 1 つあたり）と、税込か（既定は税抜）を持つ。見られるのは在庫管理の利用範囲の管理者だけ（API が取り除く）。
-- 相場の結果に、販売価格の相場か仕入れの相場かを持つ（既定は販売価格）。
alter table inventory_items add column if not exists purchase_price numeric;
alter table inventory_items add column if not exists purchase_tax_included boolean not null default false;
alter table inventory_market_checks add column if not exists kind text not null default 'sale';
do $$ begin
  alter table inventory_market_checks add constraint inventory_market_checks_kind_check check (kind in ('sale', 'purchase'));
exception when duplicate_object then null; end $$;
create index if not exists inventory_market_checks_item_kind on inventory_market_checks (tenant_id, item_id, kind, checked_at desc);
