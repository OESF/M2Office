-- 在庫の Web への公開を、1 社でいくつも持てるようにする（仕様書 第29.12.2節）
-- まとまりごとに ID と名前を持たせ、主キーを（会社・ID）にする。これまでの 1 つは「公開 1」として引き継ぐ（URL の鍵は変えない）
alter table inventory_publications add column if not exists id text;
alter table inventory_publications add column if not exists name text;
alter table inventory_publications add column if not exists created_at timestamptz not null default now();
update inventory_publications set id = 'p-' || substr(md5(tenant_id || public_key), 1, 12) where id is null;
update inventory_publications set name = '公開 1' where name is null;
alter table inventory_publications alter column id set not null;
alter table inventory_publications alter column name set not null;
-- 承認する前のまとまり（名前だけを作った）は、鍵・承認の中身・承認した人を持たない
alter table inventory_publications alter column public_key drop not null;
alter table inventory_publications alter column approved drop not null;
alter table inventory_publications alter column approved_by drop not null;
alter table inventory_publications alter column approved_at drop not null;
alter table inventory_publications drop constraint if exists inventory_publications_status_check;
alter table inventory_publications add constraint inventory_publications_status_check check (status in ('draft', 'live', 'stopped'));
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'inventory_publications_pkey'
             and pg_get_constraintdef(oid) = 'PRIMARY KEY (tenant_id)') then
    alter table inventory_publications drop constraint inventory_publications_pkey;
    alter table inventory_publications add constraint inventory_publications_pkey primary key (tenant_id, id);
  end if;
end $$;
