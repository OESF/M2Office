-- 販売品の相場と競合の比較（仕様書 第29.24節。第 0.395.0 版。Q-243）
--
-- 品目ごとに相場を調べた結果を 1 回 1 行で残す（いちばん新しい行が今の結果、月ごとの相場の履歴は 12 か月）。
-- 相手のページの文章は持たない。出典（店・URL）と取り出した価格だけを持つ。価格は比べやすいよう税込にそろえる。
create table if not exists inventory_market_checks (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  item_id     text not null,
  checked_at  timestamptz not null default now(),
  -- found（相場が見つかった）・none（同じ商品と確かめられる価格が無かった）・unavailable（調べられなかった）
  status      text not null check (status in ('found', 'none', 'unavailable')),
  our_price   numeric,
  median      numeric,
  min_price   numeric,
  max_price   numeric,
  offers      integer not null default 0,
  diff_pct    numeric,
  -- low（安め）・fair（相場並み）・high（高め）
  position    text check (position in ('low', 'fair', 'high')),
  comment     text not null default '',
  sources     jsonb not null default '[]',
  -- 誰が調べたか（利用者の ID か、月の見回りなら watch）
  checked_by  text not null
);
create index if not exists inventory_market_checks_item on inventory_market_checks (tenant_id, item_id, checked_at desc);

alter table inventory_market_checks enable row level security;
drop policy if exists tenant_isolation on inventory_market_checks;
create policy tenant_isolation on inventory_market_checks using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, delete on inventory_market_checks to m2office_app;
