-- 機械の通信量（仕様書 第23.8.7節「ネットワークの様子」）
--
-- 機械の資源の標本（runtime_samples。移行 170）に、受けた量と送った量の積み上がった数（バイト）を足す。
-- 数えるのは外とつながる口だけ（機械の中の口・WireGuard・コンテナの口は除く。読むのは API）。
-- 速さは、前の標本との差を時間で割って出す。機械を起動し直して数が戻ったとき（差が負）と、
-- 標本の間が 2 区切り以上あいたとき（12 分半より長い）は、その区間を数えない。
-- 推移は返す列が増えるので、新しい名前の関数（runtime_sample_points）にする。移行は毎回はじめから当て直すので、
-- 同じ名前のまま返す列を変えると、移行 170 の作り直しで止まる。移行 170 の関数（runtime_sample_series）は残す（前の版が使う）。
-- 直近の合計を返す関数を足す。
-- 巻き戻し: 前の版に戻せばそのまま動く（前の版は移行 170 の関数を使う）。消すなら runtime_sample_points・runtime_net_total と
-- ops の同じ名前の関数を消し、runtime_samples から net_rx・net_tx の列を消す（ほかの表から参照されない）。
alter table runtime_samples
  add column if not exists net_rx bigint,
  add column if not exists net_tx bigint;

-- 推移（使っている割合 % と、通信の速さ Mbps）。7 日は 30 分ごと、1 日は 5 分ごとにまとめる
create or replace function runtime_sample_points(p_days integer)
  returns table (at timestamptz, cpu double precision, memory double precision, swap double precision, disk double precision,
                 rx_mbps double precision, tx_mbps double precision)
  language sql stable set search_path = pg_catalog, public as $$
  with w as (
    select s.*, extract(epoch from s.at - lag(s.at) over o) as dt, lag(s.net_rx) over o as prev_rx, lag(s.net_tx) over o as prev_tx
      from runtime_samples s
     -- 窓の始まりの点の差を出すため、1 区切り前から読む
     where s.at >= now() - make_interval(days => least(greatest(p_days, 1), 7)) - interval '15 minutes'
    window o as (order by s.at)
  )
  select date_bin(case when p_days > 1 then interval '30 minutes' else interval '5 minutes' end, w.at, timestamptz '2000-01-01') as at,
         avg(w.load1 / nullif(w.cores, 0)) * 100,
         avg(1 - w.mem_free::float8 / nullif(w.mem_total, 0)) * 100,
         avg(case when w.swap_total > 0 then 1 - w.swap_free::float8 / w.swap_total end) * 100,
         avg(1 - w.disk_free::float8 / nullif(w.disk_total, 0)) * 100,
         avg(case when w.dt between 1 and 750 and w.net_rx >= w.prev_rx then (w.net_rx - w.prev_rx) * 8 / w.dt / 1e6 end),
         avg(case when w.dt between 1 and 750 and w.net_tx >= w.prev_tx then (w.net_tx - w.prev_tx) * 8 / w.dt / 1e6 end)
    from w
   where w.at >= now() - make_interval(days => least(greatest(p_days, 1), 7))
   group by 1
   order by 1
$$;
grant execute on function runtime_sample_points(integer) to m2office_app;

-- 直近の通信量の合計（バイト）。記録が無ければ null
create or replace function runtime_net_total(p_hours integer)
  returns table (rx bigint, tx bigint)
  language sql stable set search_path = pg_catalog, public as $$
  with w as (
    select s.at, s.net_rx, s.net_tx, extract(epoch from s.at - lag(s.at) over o) as dt, lag(s.net_rx) over o as prev_rx, lag(s.net_tx) over o as prev_tx
      from runtime_samples s
     where s.at >= now() - make_interval(hours => least(greatest(p_hours, 1), 168)) - interval '15 minutes'
    window o as (order by s.at)
  )
  select sum(case when w.dt between 1 and 750 and w.net_rx >= w.prev_rx then w.net_rx - w.prev_rx end)::bigint,
         sum(case when w.dt between 1 and 750 and w.net_tx >= w.prev_tx then w.net_tx - w.prev_tx end)::bigint
    from w
   where w.at >= now() - make_interval(hours => least(greatest(p_hours, 1), 168))
$$;
grant execute on function runtime_net_total(integer) to m2office_app;

-- 運営が読む口（移行 170 と同じ形）
create or replace function ops.runtime_sample_points(p_days integer)
  returns table (at timestamptz, cpu double precision, memory double precision, swap double precision, disk double precision,
                 rx_mbps double precision, tx_mbps double precision)
  language sql stable security definer set search_path = pg_catalog, public as $$
  select * from runtime_sample_points(p_days)
$$;
revoke all on function ops.runtime_sample_points(integer) from public;
grant execute on function ops.runtime_sample_points(integer) to m2office_ops;

create or replace function ops.runtime_net_total(p_hours integer)
  returns table (rx bigint, tx bigint)
  language sql stable security definer set search_path = pg_catalog, public as $$
  select * from runtime_net_total(p_hours)
$$;
revoke all on function ops.runtime_net_total(integer) from public;
grant execute on function ops.runtime_net_total(integer) to m2office_ops;
