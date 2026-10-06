-- 契約の管理（内蔵の拡張。仕様書 第38章。第 0.272.0 版）
-- 1. 会社の設定の区分（入り切りと、契約書の置き場のフォルダ）
alter table tenant_settings add column if not exists contracts jsonb;

-- 2. 台帳（結んだ契約。金額は持たない。日付は日本時間の日）
create table if not exists contracts (
  id                text primary key,
  tenant_id         text not null references tenants(id) on delete cascade,
  party             text not null default '',
  kind              text not null default 'other' check (kind in ('nda', 'basic', 'sale', 'outsourcing', 'contracting', 'lease_property', 'lease', 'maintenance', 'software', 'other')),
  title             text not null default '',
  signed_on         date,
  start_on          date,
  end_on            date,
  auto_renew        boolean not null default false,
  renew_months      integer check (renew_months is null or renew_months between 1 and 120),
  notice_rule       text not null default '',
  notice_days       integer check (notice_days is null or notice_days between 0 and 730),
  notice_deadline   date,
  status            text not null default 'active' check (status in ('active', 'cancel_requested', 'ended')),
  owner_id          text not null,
  drive_file_id     text,
  drive_file_name   text not null default '',
  review_run_id     text,
  previous_id       text references contracts(id) on delete set null,
  note              text not null default '',
  -- 読めなかった項目（「確かめてください」）
  unknown           text[] not null default '{}',
  renewed_count     integer not null default 0,
  -- 知らせた期限（'notice:60' のように、どの期限の何日前を知らせたか。期間が進んだら空にする）
  notified          text[] not null default '{}',
  created_by        text not null,
  created_at        timestamptz not null default now(),
  updated_by        text not null,
  updated_at        timestamptz not null default now()
);
create index if not exists contracts_tenant on contracts (tenant_id, status, notice_deadline, end_on);

alter table contracts enable row level security;
drop policy if exists tenant_isolation on contracts;
create policy tenant_isolation on contracts
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on contracts to m2office_app;
