-- 本人が入れたアバター（仕様書 第6.5.1.2節）
--
-- Google のプロフィール写真（user_photos。第6.5.1.1節）とは別に持つ。
-- 画面は、入れた画像 → Google の写真 → 人事の台帳の顔写真の順で使う。
-- 入れた画像を削除すると、Google の写真に戻る。
-- 1 人 1 枚。入れ直すと上書きし、古いものは残さない。利用者を消すと一緒に消える。
create table if not exists user_uploaded_photos (
  tenant_id   text not null references tenants(id) on delete cascade,
  user_id     text not null references users(id) on delete cascade,
  mime        text not null check (mime in ('image/png', 'image/jpeg')),
  bytes       bytea not null check (octet_length(bytes) between 1 and 1048576),
  uploaded_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

alter table user_uploaded_photos enable row level security;
drop policy if exists tenant_isolation on user_uploaded_photos;
create policy tenant_isolation on user_uploaded_photos
  using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, update, delete on user_uploaded_photos to m2office_app;
