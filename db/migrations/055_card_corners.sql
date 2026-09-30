-- 名刺の四隅と、1 枚の写真に何枚も写った名刺（仕様書 第27.4節・第27.5節、Q-93）
--
-- 推論が答えた名刺の四隅（画像の幅と高さを 1,000 とした割合。名刺の文字の向きで左上・右上・右下・左下の順）を表と裏ごとに持つ。
-- 画面はこれで名刺の範囲を切り出し、傾きを直して出す（サーバーでは画像を作り直さない）。
-- 1 枚の写真に何枚も写っていれば、同じ画像を名刺ごとの四隅で指す。そのため、画像は、それを指す名刺が残っている間は消さない。

alter table contact_cards add column if not exists front_corners jsonb;
alter table contact_cards add column if not exists back_corners jsonb;

-- 期限を過ぎたものを本当に消す（第27.7節）。画像は、ほかの名刺が指していなければ消す
create or replace function m2o_purge_contact_cards(card_ids text[]) returns integer
  language plpgsql security definer set search_path = public as $$
declare
  n integer;
  files_to_drop text[];
  contacts_to_drop text[];
begin
  select coalesce(array_agg(f), '{}') into files_to_drop
    from (select front_file_id as f from contact_cards where id = any(card_ids) and front_file_id is not null
          union select back_file_id from contact_cards where id = any(card_ids) and back_file_id is not null) s;
  select coalesce(array_agg(distinct contact_id), '{}') into contacts_to_drop
    from contact_cards where id = any(card_ids) and contact_id is not null;
  delete from contact_cards where id = any(card_ids);
  get diagnostics n = row_count;
  -- 名刺が残っていない、ごみ箱の連絡先を消す
  delete from contacts k where k.id = any(contacts_to_drop) and k.status = 'trash'
     and not exists (select 1 from contact_cards c where c.contact_id = k.id);
  delete from files f where f.id = any(files_to_drop)
     and not exists (select 1 from contact_cards c where c.front_file_id = f.id or c.back_file_id = f.id);
  return n;
end $$;
revoke all on function m2o_purge_contact_cards(text[]) from public;
grant execute on function m2o_purge_contact_cards(text[]) to m2office_app;

-- 画像を、指定した名刺のほかに指している名刺があるか（置き場のファイルを消す前に確かめる。自分だけの名刺も数えるため、行の制限を越えて見る）
create or replace function m2o_card_file_in_use(p_tenant text, p_file text, p_exclude text[]) returns boolean
  language sql security definer set search_path = public as $$
  select exists (select 1 from contact_cards c
                  where c.tenant_id = p_tenant and (c.front_file_id = p_file or c.back_file_id = p_file)
                    and not (c.id = any(p_exclude)));
$$;
revoke all on function m2o_card_file_in_use(text, text, text[]) from public;
grant execute on function m2o_card_file_in_use(text, text, text[]) to m2office_app;
