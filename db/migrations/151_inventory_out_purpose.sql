-- 出庫の用途（仕様書 第29.9.1節。第 0.407.0 版。Q-247）
--
-- 出庫に用途（販売・社内消費・廃棄・その他）を持つ。ボタンで選び、理由の文を打たずに済むようにする。
-- 廃棄は需要の予測の「使う速さ」に入れない。入庫・移動・調整は用途を持たない（null）。
-- いまの記録: 販売の通知からの出庫は販売、予約で使ったものは社内消費、理由に「廃棄」「期限切れ」「破損」を含むものは廃棄。ほかは null（その他と同じに数える）。
alter table inventory_moves add column if not exists purpose text;
do $$ begin
  alter table inventory_moves add constraint inventory_moves_purpose_check check (purpose is null or purpose in ('sale', 'internal', 'disposal', 'other'));
exception when duplicate_object then null; end $$;
update inventory_moves set purpose = case
    when source = 'sales' then 'sale'
    when source = 'reservation' then 'internal'
    when reason ~ '(廃棄|期限切れ|破損)' then 'disposal'
  end
  where kind = 'out' and purpose is null;
create index if not exists inventory_moves_item_out_idx on inventory_moves (tenant_id, item_id, created_at desc) where kind = 'out';
