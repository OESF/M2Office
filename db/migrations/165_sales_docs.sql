-- 販売の書類と受注（内蔵の拡張。仕様書 第42章、Q-272・Q-273、ADR-0112）。
-- 注文書・納品書・請求書・領収書（sales_documents）と、受け取った注文書から作る受注（sales_orders）と、取引先の覚え（sales_parties）。
-- 書類を作るところまでを扱い、入金・支払い・会計は持たない。金額は数量と単価から決まった計算で出したもの。
-- 発行した書類は書き換えず、訂正は同じ番号の新しい版（version）、取り消しは状態で表す（電子帳簿保存法。第42.6節）。
-- 巻き戻し: 3 つの表と tenant_settings.sales_docs の列を消す（ほかの表から参照されない）。

alter table tenant_settings add column if not exists sales_docs jsonb;

create table if not exists sales_orders (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  number        text not null,
  party         jsonb not null default '{}',
  customer_ref  text not null default '',
  ordered_on    date,
  due_on        date,
  deliver_to    text not null default '',
  terms         text not null default '',
  notes         text not null default '',
  items         jsonb not null default '[]',
  subtotal      bigint not null default 0,
  tax           bigint not null default 0,
  total         bigint not null default 0,
  stated_total  bigint,
  cancelled     boolean not null default false,
  cancel_reason text not null default '',
  flags         jsonb not null default '[]',
  source_file_id text,
  source        text not null default 'upload' check (source in ('upload', 'secretary', 'mail', 'quote')),
  quote_number  text,
  created_by    text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, number)
);
create index if not exists sales_orders_tenant_idx on sales_orders (tenant_id, created_at desc);

create table if not exists sales_documents (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  kind          text not null check (kind in ('purchase_order', 'delivery', 'invoice', 'receipt')),
  number        text,
  version       integer not null default 1,
  previous_id   text,
  superseded    boolean not null default false,
  status        text not null default 'draft' check (status in ('draft', 'issued', 'cancelled')),
  party         jsonb not null default '{}',
  subject       text not null default '',
  items         jsonb not null default '[]',
  subtotal      bigint not null default 0,
  tax           bigint not null default 0,
  total         bigint not null default 0,
  tax_lines     jsonb not null default '[]',
  issued_on     date not null,
  due_on        date,
  terms         text not null default '',
  notes         text not null default '',
  order_id      text,
  invoice_id    text,
  delivery_ids  jsonb not null default '[]',
  file_id       text,
  cancel_reason text not null default '',
  notices       jsonb not null default '[]',
  run_id        text,
  created_by    text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, number, version)
);
create index if not exists sales_documents_tenant_idx on sales_documents (tenant_id, issued_on desc, created_at desc);
create index if not exists sales_documents_order_idx on sales_documents (tenant_id, order_id);

create table if not exists sales_parties (
  tenant_id     text not null references tenants(id) on delete cascade,
  key           text not null,
  name          text not null,
  honorific     text not null default '',
  closing_day   integer,
  payment_terms text not null default '',
  learned_from  text not null default '',
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, key)
);

alter table sales_orders enable row level security;
drop policy if exists tenant_isolation on sales_orders;
create policy tenant_isolation on sales_orders using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on sales_orders to m2office_app;

alter table sales_documents enable row level security;
drop policy if exists tenant_isolation on sales_documents;
create policy tenant_isolation on sales_documents using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on sales_documents to m2office_app;

alter table sales_parties enable row level security;
drop policy if exists tenant_isolation on sales_parties;
create policy tenant_isolation on sales_parties using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on sales_parties to m2office_app;
