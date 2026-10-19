-- 品目の区分と販売品の消費税率（仕様書 第29.6.1節。第 0.392.0 版。Q-242）
--
-- 区分は販売品・消耗品・原材料・その他の 4 つに固定する。いまの品目は、分類の名前に「販売」を含むか販売価格の入っている品目を販売品に、
-- 分類の名前に「原材料」「材料」を含む品目を原材料に、ほかを消耗品にする。消費税率は販売品だけが使う（10 か 8）。
alter table inventory_items add column if not exists kind text;
alter table inventory_items add column if not exists tax_rate smallint not null default 10;
update inventory_items set kind = case
    when category like '%販売%' or price is not null then 'sale'
    when category like '%原材料%' or category like '%材料%' then 'material'
    else 'supply' end
  where kind is null;
alter table inventory_items alter column kind set default 'supply';
alter table inventory_items alter column kind set not null;
do $$ begin
  alter table inventory_items add constraint inventory_items_kind_check check (kind in ('sale', 'supply', 'material', 'other'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table inventory_items add constraint inventory_items_tax_rate_check check (tax_rate in (8, 10));
exception when duplicate_object then null; end $$;
