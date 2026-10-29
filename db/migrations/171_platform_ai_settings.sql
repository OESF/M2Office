-- マスター管理画面の設定を広げる（仕様書 第23.8.14節「マスター管理画面の設定を広げる」、Q-285）。
-- 運営の鍵（Gemini の共通の鍵）と、運営の鍵を使う会社の上限の既定・運営の鍵の全体の月の上限を、配備に 1 つ持つ。
-- 鍵はアプリと同じ暗号の鍵（M2OFFICE_SECRET_KEY）で暗号化したまま置く。運営のロールが書き、アプリのロールは決めた関数で暗号化したまま読む。
-- AI の利用の記録（ai_usage）に、運営の鍵で使ったかの印を足し、全社の今月の合計を決めた関数で数える（会社の中身は返さない）。
-- 巻き戻し: 関数と表 ops.platform_settings を消し、ai_usage から platform_key の列を消す（ほかの表から参照されない）。

create table if not exists ops.platform_settings (
  id                  integer primary key default 1 check (id = 1),
  gemini_key_enc      text,
  gemini_key_tail     text,
  gemini_key_set_at   timestamptz,
  gemini_key_set_by   text,
  ai_tenant_cap_jpy   numeric(12, 0) check (ai_tenant_cap_jpy is null or ai_tenant_cap_jpy > 0),
  ai_platform_cap_jpy numeric(12, 0) check (ai_platform_cap_jpy is null or ai_platform_cap_jpy > 0),
  updated_by          text not null default '',
  updated_at          timestamptz not null default now()
);
insert into ops.platform_settings (id) values (1) on conflict (id) do nothing;
grant select, update on ops.platform_settings to m2office_ops;

alter table ai_usage add column if not exists platform_key boolean not null default false;
create index if not exists ai_usage_platform_at on ai_usage (at) where platform_key;

-- アプリのロールが読む口（鍵は暗号化したまま。上限）
create or replace function m2o_platform_ai_settings()
  returns table (gemini_key_enc text, gemini_key_set_at timestamptz, ai_tenant_cap_jpy numeric, ai_platform_cap_jpy numeric)
  language sql stable security definer set search_path = pg_catalog, ops as $$
  select gemini_key_enc, gemini_key_set_at, ai_tenant_cap_jpy, ai_platform_cap_jpy from ops.platform_settings where id = 1;
$$;
revoke all on function m2o_platform_ai_settings() from public;
grant execute on function m2o_platform_ai_settings() to m2office_app;

-- 運営の鍵での全社の合計（円。p_since から。ローカル AI は含めない）。アプリと運営のロールが数える
create or replace function m2o_ai_platform_total(p_since timestamptz)
  returns numeric
  language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce(sum(cost_jpy), 0) from ai_usage where platform_key and not local and at >= p_since;
$$;
revoke all on function m2o_ai_platform_total(timestamptz) from public;
grant execute on function m2o_ai_platform_total(timestamptz) to m2office_app;

create or replace function ops.ai_platform_total(p_since timestamptz)
  returns numeric
  language sql stable security definer set search_path = pg_catalog, public as $$
  select m2o_ai_platform_total(p_since);
$$;
revoke all on function ops.ai_platform_total(timestamptz) from public;
grant execute on function ops.ai_platform_total(timestamptz) to m2office_ops;
