-- コラムの「AI が書いたことの表示」の既定を「入れない」に改める（仕様書 第32.4節・Q-164。第 0.596.0 版）。
-- 何を断るかは公開する人の責任で決める。M2Office が勝手に断り書きを足さない（三浦さんの判断。2026-11-15）。
-- いままでの会社は、既定の「入れる」が設定の保存のときにそのまま残っていた（自分で選んだのではない）ので、切りに戻す。
-- 入れたい会社は、管理者が「拡張機能 › コラムの作成」で入れ直す。
--
-- 移行のファイルは毎回すべて当て直されるため、一度だけ行う印（m2o_data_fixes。移行 115）を持つ。
-- 印が無いと、このあと管理者が入れ直した値まで、移行のたびに切りに戻してしまう。
--
-- 巻き戻し: 前の版に戻しても動く（値を読むだけ）。値を戻すなら
--   update tenant_settings set web_columns = jsonb_set(web_columns, '{aiNotice}', 'true') where web_columns ? 'aiNotice';
--   delete from m2o_data_fixes where id = 'column-ai-notice-off-0.596';

do $$
begin
  if exists (select 1 from m2o_data_fixes where id = 'column-ai-notice-off-0.596') then return; end if;
  update tenant_settings set web_columns = jsonb_set(web_columns, '{aiNotice}', 'false')
   where web_columns ? 'aiNotice' and web_columns->'aiNotice' = 'true'::jsonb;
  insert into m2o_data_fixes (id) values ('column-ai-notice-off-0.596');
end $$;
