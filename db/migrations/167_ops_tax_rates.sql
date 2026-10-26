-- 消費税の税率の表を運営の表に持つ（仕様書 第15.1.1.1節・第23.8.13節、Q-276）。
-- 運営者がマスター管理画面で、予定の確定・税率と日付の直し・行の追加・取り下げを行う。全社に効く。会社は読むだけ。
-- 行が 1 つも無ければ、M2Office に同梱した表を使う（初めて保存したときに同梱の表を写して直す）。
-- 巻き戻し: 関数と表を消す（同梱の表に戻る）。

create table if not exists ops.tax_rates (
  id          text primary key,
  category    text not null check (category in ('standard', 'food', 'news', 'exempt')),
  rate        numeric(5, 2) not null check (rate >= 0 and rate <= 100),
  from_on     date not null,
  to_on       date,
  planned     boolean not null default false,
  note        text not null default '',
  source_url  text not null default '',
  checked_on  date,
  updated_by  text not null default '',
  updated_at  timestamptz not null default now(),
  check (to_on is null or to_on >= from_on)
);
grant select, insert, update, delete on ops.tax_rates to m2office_ops;

-- 顧客の側が税率の表を読む口。運営が直していなければ 0 行（同梱の表を使う）
create or replace function m2o_tax_rates()
  returns table (category text, rate numeric, from_on date, to_on date, planned boolean, note text)
  language sql stable security definer set search_path = pg_catalog, ops as $$
  select category, rate, from_on, to_on, planned, note from ops.tax_rates order by category, from_on;
$$;
revoke all on function m2o_tax_rates() from public;
grant execute on function m2o_tax_rates() to m2office_app;

-- 税率を直す前に見せる、全社の書類の下書きの数（発行するときに新しい税率で計算し直す）。中身は出さない
create or replace function ops.sales_draft_count()
  returns integer
  language sql stable security definer set search_path = pg_catalog, public as $$
  select count(*)::integer from sales_documents where status = 'draft';
$$;
revoke all on function ops.sales_draft_count() from public;
grant execute on function ops.sales_draft_count() to m2office_ops;

-- 税率が確定したことを、販売の書類と受注を使う会社の管理者に知らせる（種類 service）
create or replace function ops.tax_rate_notice(p_title text, p_body text)
  returns integer
  language plpgsql security definer set search_path = pg_catalog, public as $$
declare n integer;
begin
  insert into notifications (id, tenant_id, user_id, kind, title, body, created_at)
    select gen_random_uuid()::text, u.tenant_id, u.id, 'service', p_title, p_body, now()
      from users u join tenant_settings s on s.tenant_id = u.tenant_id
     where u.status = 'active' and 'admin' = any (u.roles) and coalesce((s.sales_docs->>'enabled')::boolean, false);
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function ops.tax_rate_notice(text, text) from public;
grant execute on function ops.tax_rate_notice(text, text) to m2office_ops;
