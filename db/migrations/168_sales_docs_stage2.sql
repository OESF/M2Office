-- 販売の書類と受注の段 2（仕様書 第42.13節、Q-277）。
-- メールに届いた注文書の取り込み・締めの請求書の下書き・納期の見張り・在庫との連動・注文請書。
-- 巻き戻し: 足した列と表を消し、書類の種類の制約を元の 4 つに戻す（注文請書を消してから）。

alter table sales_documents drop constraint if exists sales_documents_kind_check;
alter table sales_documents add constraint sales_documents_kind_check check (kind in ('purchase_order', 'delivery', 'invoice', 'receipt', 'acknowledgement'));
-- 納品書で出庫した在庫の記録（取り消しで戻すため）
alter table sales_documents add column if not exists stock_moves jsonb not null default '[]';

alter table sales_orders add column if not exists mail_message_id text;
alter table sales_orders add column if not exists stock jsonb not null default '[]';
alter table sales_orders add column if not exists due_notified_on date;
create index if not exists sales_orders_mail_idx on sales_orders (tenant_id, mail_message_id);

-- メールの見回り: 人ごとに、見た時刻とその日の取り込みの数、見たメール
create table if not exists sales_mail_cursors (
  tenant_id   text not null references tenants(id) on delete cascade,
  user_id     text not null,
  checked_at  timestamptz not null,
  day         date,
  day_count   integer not null default 0,
  primary key (tenant_id, user_id)
);
create table if not exists sales_mail_seen (
  tenant_id   text not null references tenants(id) on delete cascade,
  user_id     text not null,
  mail_id     text not null,
  seen_at     timestamptz not null default now(),
  primary key (tenant_id, user_id, mail_id)
);

-- 朝の見回りを日に 1 回にする記録と、締めの請求書の下書きを作った区切り（削除されても作り直さない）
create table if not exists sales_watch_runs (
  tenant_id   text not null references tenants(id) on delete cascade,
  kind        text not null,
  day         date not null,
  primary key (tenant_id, kind, day)
);
create table if not exists sales_closing_runs (
  tenant_id   text not null references tenants(id) on delete cascade,
  party_key   text not null,
  cutoff      date not null,
  primary key (tenant_id, party_key, cutoff)
);

alter table sales_mail_cursors enable row level security;
drop policy if exists tenant_isolation on sales_mail_cursors;
create policy tenant_isolation on sales_mail_cursors using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on sales_mail_cursors to m2office_app;
alter table sales_mail_seen enable row level security;
drop policy if exists tenant_isolation on sales_mail_seen;
create policy tenant_isolation on sales_mail_seen using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on sales_mail_seen to m2office_app;
alter table sales_watch_runs enable row level security;
drop policy if exists tenant_isolation on sales_watch_runs;
create policy tenant_isolation on sales_watch_runs using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on sales_watch_runs to m2office_app;
alter table sales_closing_runs enable row level security;
drop policy if exists tenant_isolation on sales_closing_runs;
create policy tenant_isolation on sales_closing_runs using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on sales_closing_runs to m2office_app;
