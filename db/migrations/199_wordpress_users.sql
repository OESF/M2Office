-- サイトの更新で、一人ひとりが自分の WordPress の利用者でつなぐ（仕様書 第45.16節、ADR-0141。第 0.566.0 版）
--
-- 1. 本人の WordPress の接続。サイトは会社の接続のもの（つないだときのサイトの URL を持ち、会社のサイトが変われば使わない）。
--    パスワードは暗号化して持ち、本人だけが使う。テナントと本人で絞る（不変則 I-2）。
-- 2. サイトの直しに、使った接続（会社か本人か）と WordPress の利用者名を持つ（承認の後に同じ接続で入れるため）。

create table if not exists user_wordpress_connections (
  tenant_id     text not null references tenants(id) on delete cascade,
  user_id       text not null,
  site_url      text not null,
  username      text not null,
  secret_enc    text not null,
  display_name  text not null default '',
  roles         text[] not null default '{}',
  connected_at  timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

alter table site_edits add column if not exists auth_kind text not null default 'company';
alter table site_edits drop constraint if exists site_edits_auth_kind_check;
alter table site_edits add constraint site_edits_auth_kind_check check (auth_kind in ('company', 'user')) not valid;
alter table site_edits add column if not exists wp_username text not null default '';

do $$
declare t text;
begin
  foreach t in array array['user_wordpress_connections'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
    execute format('grant select, insert, update, delete on %I to m2office_app', t);
  end loop;
end $$;
