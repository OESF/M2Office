-- 運営者を無効にしたら、その運営者の代理アクセス（申請中・閲覧中）をすべて終える（仕様書 第23.6.1節・第16.9節。第 0.344.1 版）
--
-- これまでは運営の画面のログイン状態だけを失効させ、会社の側の閲覧のログイン状態は許した期限まで残っていた
-- （2026-10-12 の点検で見つけた）。1 件ずつの終わらせ方（ops.end_proxy）と同じく、会社の管理者に知らせる。
create or replace function ops.end_operator_proxies(p_operator text)
  returns integer
  language plpgsql security definer set search_path = pg_catalog, public, ops as $$
declare
  g record;
  n integer := 0;
begin
  for g in select id from proxy_grants
            where operator_id = p_operator and (state = 'requested' or (state = 'approved' and expires_at > now())) loop
    perform ops.end_proxy(g.id, p_operator);
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function ops.end_operator_proxies(text) from public;
grant execute on function ops.end_operator_proxies(text) to m2office_ops;
