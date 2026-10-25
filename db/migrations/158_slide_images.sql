-- スライドの画像の使い捨ての置き場（仕様書 第9.4.2節「段 2」、Q-263）。
-- Google スライドは Google から読める URL でしか画像を受け取らないため、クラウドの形では M2Office が使い捨ての URL で画像を渡す。
-- 鍵（32 バイトの乱数）は SHA-256 だけを持ち、5 分で切れ、貼り終えたらすぐ消す。会社のデータは入れない（資料のテーマの絵と円グラフだけ）。
-- 公開の道（/v1/public/slide-images/<鍵>）は会社の判定より前に来るため、鍵のハッシュから 1 枚だけ返す関数で読む。
-- 巻き戻し: 表と関数を消す（ほかの表から参照されない）。

create table if not exists slide_images (
  token_hash  text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  mime        text not null check (mime in ('image/png', 'image/jpeg', 'image/gif')),
  bytes       bytea not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists slide_images_expires on slide_images (expires_at);

alter table slide_images enable row level security;
drop policy if exists tenant_isolation on slide_images;
create policy tenant_isolation on slide_images using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant());
grant select, insert, delete on slide_images to m2office_app;

-- 鍵のハッシュから、切れていない画像を 1 枚だけ返す（公開の道が使う。会社を問わない）
create or replace function m2o_slide_image(p_hash text) returns table (mime text, bytes bytea)
  language sql stable security definer set search_path = pg_catalog, public as $$
  select s.mime, s.bytes from slide_images s where s.token_hash = p_hash and s.expires_at > now()
$$;
revoke all on function m2o_slide_image(text) from public;
grant execute on function m2o_slide_image(text) to m2office_app;
