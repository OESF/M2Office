-- 従業員の顔写真（仕様書 第30.5.4節、ADR-0055）
--
-- 1 人 1 枚。取り込み直すたびに上書きし、古い写真は残さない。
-- 画像は画面で縮めてから受け取るので小さい（1 MB まで）。業務のファイルの置き場（files）には入れない。
-- 従業員の台帳と同じ期間残す（台帳を消すと一緒に消える。ADR-0054 の 7 年）。
create table if not exists hr_employee_photos (
  tenant_id    text not null references tenants(id) on delete cascade,
  employee_id  text not null references hr_employees(id) on delete cascade,
  mime         text not null check (mime in ('image/png', 'image/jpeg')),
  bytes        bytea not null check (octet_length(bytes) between 1 and 1048576),
  updated_by   text not null,
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, employee_id)
);

alter table hr_employee_photos enable row level security;
drop policy if exists tenant_isolation on hr_employee_photos;
create policy tenant_isolation on hr_employee_photos
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on hr_employee_photos to m2office_app;
