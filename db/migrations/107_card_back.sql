-- 名刺の裏面（仕様書 第27.5.1節、ADR-0082。第 0.299.0 版）。
-- 連絡先に、英語の表記（氏名・会社名・部署・役職・住所）・裏の文（2,000 字まで）・関連会社と商品・サービスの名前の一覧を足す。
-- 名刺に、裏から読んだもの（表の見つからない裏を、後で表と組にするため）と、裏を読んだ時刻（これまでの名刺の読み直しに使う）を足す。

alter table contacts add column if not exists english jsonb;
alter table contacts add column if not exists back_text text not null default '';
alter table contacts add column if not exists related text[] not null default '{}';
alter table contacts add column if not exists products text[] not null default '{}';
alter table contact_cards add column if not exists back_info jsonb;
alter table contact_cards add column if not exists back_read_at timestamptz;

-- これまでの名刺のうち、裏の画像があってまだ裏を読んでいないものを 1 枚取る（Q-216）。
-- 自分だけの名刺も含めて見るため、この関数だけが会社と持ち主をまたぐ。取った時点で読んだ印を付ける（失敗しても繰り返さない）
create or replace function m2o_claim_card_back() returns table (id text, tenant_id text, owner_user_id text)
  language sql security definer set search_path = public as $$
  update contact_cards c
     set back_read_at = now(), updated_at = now()
   where c.id = (
     select x.id from contact_cards x
      where x.back_file_id is not null and x.back_read_at is null and x.status = 'done' and x.contact_id is not null
      order by x.created_at
      limit 1
      for update skip locked
   )
  returning c.id, c.tenant_id, c.owner_user_id
$$;
revoke all on function m2o_claim_card_back() from public;
grant execute on function m2o_claim_card_back() to m2office_app;
