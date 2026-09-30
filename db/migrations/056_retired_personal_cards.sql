-- 退職した人の自分だけの名刺（仕様書 第27.7節、Q-94）
--
-- 利用者を止めた日時を持ち、止めてから 30 日を過ぎた人の自分だけの名刺を、期限の見回りで画像ごと削除する。
-- 30 日のうちに利用者を戻せば、止めた日時を空にして削除しない。

alter table users add column if not exists disabled_at timestamptz;
-- いま止まっている利用者は、この移行の日から数える（過去に止めた日は分からないため）
update users set disabled_at = now() where status = 'disabled' and disabled_at is null;

-- 期限を過ぎたものを探す: ごみ箱に 30 日置いた連絡先、読み取れなかった名刺（4 週）、止めてから 30 日を過ぎた人の自分だけの名刺。
-- 自分だけのものも含めて見るため、この関数だけが会社と持ち主をまたぐ（第27.7節・第27.5節）
create or replace function m2o_expired_contact_cards() returns table (
  tenant_id text, card_id text, contact_id text, front_file_id text, back_file_id text
)
  language sql security definer set search_path = public as $$
  select c.tenant_id, c.id, c.contact_id, c.front_file_id, c.back_file_id
    from contact_cards c
    left join contacts k on k.id = c.contact_id
    left join users u on u.id = c.owner_user_id and u.tenant_id = c.tenant_id
   where (k.status = 'trash' and k.trashed_at < now() - interval '30 days')
      or (c.status = 'failed' and c.updated_at < now() - interval '28 days')
      or (c.scope = 'personal' and u.status = 'disabled' and u.disabled_at < now() - interval '30 days')
$$;
revoke all on function m2o_expired_contact_cards() from public;
grant execute on function m2o_expired_contact_cards() to m2office_app;

-- 期限を過ぎたものを本当に消す（第27.7節）。画像は、ほかの名刺が指していなければ消す（移行 055）。
-- 名刺が残っていない連絡先のうち、ごみ箱のものと、止めてから 30 日を過ぎた人の自分だけのものを消す
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
  delete from contacts k where k.id = any(contacts_to_drop)
     and not exists (select 1 from contact_cards c where c.contact_id = k.id)
     and (k.status = 'trash'
          or (k.scope = 'personal' and exists (select 1 from users u where u.id = k.owner_user_id and u.tenant_id = k.tenant_id
                                                 and u.status = 'disabled' and u.disabled_at < now() - interval '30 days')));
  delete from files f where f.id = any(files_to_drop)
     and not exists (select 1 from contact_cards c where c.front_file_id = f.id or c.back_file_id = f.id);
  return n;
end $$;
revoke all on function m2o_purge_contact_cards(text[]) from public;
grant execute on function m2o_purge_contact_cards(text[]) to m2office_app;

-- 利用者の自分だけの名刺（連絡先）の数。止めるときに管理者へ件数だけを示すため、行の制限を越えて数える（中身は返さない）
create or replace function m2o_count_personal_contacts(p_tenant text, p_user text) returns integer
  language sql security definer set search_path = public as $$
  select count(*)::int from contacts
   where tenant_id = p_tenant and owner_user_id = p_user and scope = 'personal' and status = 'active';
$$;
revoke all on function m2o_count_personal_contacts(text, text) from public;
grant execute on function m2o_count_personal_contacts(text, text) to m2office_app;
