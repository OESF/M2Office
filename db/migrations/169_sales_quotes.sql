-- 見積書を販売の書類の 1 つにする（仕様書 第42.14節、Q-278）。保存と一覧・再見積（同じ番号の新しい版）・失注・見積からの受注。
-- いままでの見積書（quotes。第9.5.8節）を書類（種類 見積書・版 1）に写す。quotes は読むだけにして残す。
-- 巻き戻し: 写した見積書（kind = 'quote'）を消し、足した列を消し、書類の種類の制約を戻す。

alter table sales_documents drop constraint if exists sales_documents_kind_check;
alter table sales_documents add constraint sales_documents_kind_check check (kind in ('quote', 'purchase_order', 'delivery', 'invoice', 'receipt', 'acknowledgement'));
alter table sales_documents add column if not exists valid_until date;
alter table sales_documents add column if not exists outcome text check (outcome is null or outcome in ('won', 'lost'));
alter table sales_documents add column if not exists outcome_note text not null default '';
alter table sales_orders add column if not exists quote_id text;

insert into sales_documents (id, tenant_id, kind, number, version, status, party, subject, items, subtotal, tax, total, tax_lines,
  issued_on, valid_until, file_id, run_id, created_by, created_at, updated_at)
select 'sd-' || q.id, q.tenant_id, 'quote', q.number, 1, 'issued', jsonb_build_object('name', regexp_replace(q.to_name, '\s*(御中|様|殿)$', ''), 'department', '', 'person', '', 'address', '', 'phone', '', 'email', ''),
       '', q.items, q.subtotal, q.tax, q.total, '[]'::jsonb, (q.created_at at time zone 'Asia/Tokyo')::date, q.valid_until, q.file_id, q.run_id, q.requested_by, q.created_at, q.created_at
  from quotes q
 where not exists (select 1 from sales_documents d where d.tenant_id = q.tenant_id and d.kind = 'quote' and d.number = q.number);
