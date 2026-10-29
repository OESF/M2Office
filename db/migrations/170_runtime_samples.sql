-- 機械の資源の図（仕様書 第23.8.7節「機械の資源の図」・第8.6.7.1節、Q-281）。
-- 動いている知らせ（runtime_beats）に、CPU の負荷・Swap・ファイルの置き場があるディスクを足す。
-- 推移の図のために、API が 5 分ごとに機械の様子の標本を runtime_samples に置き、7 日より古いものを消す（1 台で 2,016 行ほど）。
-- どちらも会社を持たない表（機械の様子であり、会社のデータではない）。秘密の値・業務の中身・個人の情報は置かない。
-- 運営のロール（m2office_ops）は、決めた関数 ops.runtime_beats() と ops.runtime_samples() を通してだけ読む。
-- 巻き戻し: 関数 runtime_sample_series・ops.runtime_samples と表 runtime_samples を消し、runtime_beats から足した列を消す（ほかの表から参照されない）。

alter table runtime_beats
  add column if not exists load1      real,
  add column if not exists load5      real,
  add column if not exists load15     real,
  add column if not exists swap_total bigint,
  add column if not exists swap_free  bigint,
  add column if not exists disk_total bigint,
  add column if not exists disk_free  bigint;

create table if not exists runtime_samples (
  at          timestamptz not null default now(),
  load1       real,
  cores       integer,
  mem_total   bigint,
  mem_free    bigint,
  swap_total  bigint,
  swap_free   bigint,
  disk_total  bigint,
  disk_free   bigint
);
create index if not exists runtime_samples_at on runtime_samples (at);
grant select, insert, delete on runtime_samples to m2office_app;

-- 推移（使っている割合 %）。7 日は 30 分ごと、1 日は 5 分ごとにまとめる（画面に送る点の数を抑える）。
-- CPU の負荷は 1 分の平均の負荷 ÷ コアの数。Swap の無い機械（全体が 0）は null。
create or replace function runtime_sample_series(p_days integer)
  returns table (at timestamptz, cpu double precision, memory double precision, swap double precision, disk double precision)
  language sql stable set search_path = pg_catalog, public as $$
  select date_bin(case when p_days > 1 then interval '30 minutes' else interval '5 minutes' end, s.at, timestamptz '2000-01-01') as at,
         avg(s.load1 / nullif(s.cores, 0)) * 100,
         avg(1 - s.mem_free::float8 / nullif(s.mem_total, 0)) * 100,
         avg(case when s.swap_total > 0 then 1 - s.swap_free::float8 / s.swap_total end) * 100,
         avg(1 - s.disk_free::float8 / nullif(s.disk_total, 0)) * 100
    from runtime_samples s
   where s.at >= now() - make_interval(days => least(greatest(p_days, 1), 7))
   group by 1
   order by 1
$$;
grant execute on function runtime_sample_series(integer) to m2office_app;

-- 列を足したので、運営が読む関数を作り直す（setof runtime_beats の列が増える）
create or replace function ops.runtime_beats()
  returns setof runtime_beats
  language sql stable security definer set search_path = pg_catalog, public as $$
  select * from runtime_beats
$$;
revoke all on function ops.runtime_beats() from public;
grant execute on function ops.runtime_beats() to m2office_ops;

create or replace function ops.runtime_samples(p_days integer)
  returns table (at timestamptz, cpu double precision, memory double precision, swap double precision, disk double precision)
  language sql stable security definer set search_path = pg_catalog, public as $$
  select * from runtime_sample_series(p_days)
$$;
revoke all on function ops.runtime_samples(integer) from public;
grant execute on function ops.runtime_samples(integer) to m2office_ops;
