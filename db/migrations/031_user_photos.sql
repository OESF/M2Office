-- 本人のアバター（Google のプロフィール写真。仕様書 第6.5.1.1節）
--
-- 1 人 1 枚。取り込み直すたびに上書きし、古い写真は残さない。
-- 画像そのものをここに持つ。業務のファイルの置き場（files）には入れない。
-- 業務のファイルの決まり（入れ替え・見られる人）に巻き込まないためである。
-- 利用者を消すと一緒に消える。
create table if not exists user_photos (
  tenant_id   text not null references tenants(id) on delete cascade,
  user_id     text not null references users(id) on delete cascade,
  mime        text not null check (mime in ('image/png', 'image/jpeg')),
  bytes       bytea not null check (octet_length(bytes) between 1 and 1048576),
  fetched_at  timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

alter table user_photos enable row level security;
drop policy if exists tenant_isolation on user_photos;
create policy tenant_isolation on user_photos
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on user_photos to m2office_app;
