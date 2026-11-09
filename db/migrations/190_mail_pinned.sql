-- メールの画面「メール」を業務の並びに置き、ピン止めする（仕様書 第9.5.1.1節「画面」。第 0.540.0 版）
--
-- まだ一度もピン止めを変えていない人（menu.pinned が無い）は、標準の組（DEFAULT_PINNED）に入っているので何もしない。
-- 自分でピン止めを変えていた人には、一度だけ「mail」を足す（外した人に戻し続けないよう、一度だけ行う印を使う）。
-- 並びはメニューの順で決まるので、配列の終わりに足せばよい。
do $$
begin
  if exists (select 1 from m2o_data_fixes where id = 'mail-pinned-0.540') then return; end if;
  update user_settings
     set menu = jsonb_set(menu, '{pinned}', (menu -> 'pinned') || '["mail"]'::jsonb)
   where jsonb_typeof(menu -> 'pinned') = 'array'
     and not (menu -> 'pinned') ? 'mail';
  insert into m2o_data_fixes (id) values ('mail-pinned-0.540');
end $$;
