-- 動いている環境（仕様書 第8.6.7.1節）。API とワーカーが、起動のときと 5 分ごとに、M2Office の版・Node.js の版・起動の時刻・
-- 機械の様子（OS・CPU・メモリー）を置く。会社を持たない表（機械の様子であり、会社のデータではない）。秘密の値・業務の中身・個人の情報は置かない。
-- 運営のロール（m2office_ops）は、決めた関数 ops.runtime_beats() を通してだけ読む（クラウドの形の「稼働状況」に出す）。
-- 巻き戻し: 関数と表を消す（ほかの表から参照されない）。

create table if not exists runtime_beats (
  role        text primary key check (role in ('api', 'worker')),
  version     text,
  node        text not null,
  started_at  timestamptz not null,
  at          timestamptz not null default now(),
  os_name     text,
  arch        text,
  cpu         text,
  cores       integer,
  mem_total   bigint,
  mem_free    bigint
);
grant select, insert, update on runtime_beats to m2office_app;

create or replace function ops.runtime_beats()
  returns setof runtime_beats
  language sql stable security definer set search_path = pg_catalog, public as $$
  select * from runtime_beats
$$;
revoke all on function ops.runtime_beats() from public;
grant execute on function ops.runtime_beats() to m2office_ops;
