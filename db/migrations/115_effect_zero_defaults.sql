-- 効果の推計の「0 分」を一度だけ消す（仕様書 第6.7.12節。第 0.316.0 版）
--
-- 第 0.315.0 版で、秘書の業務と内蔵・同梱の拡張機能の業務に標準所要時間の既定値を付けた。それより前は既定値が 0 で、
-- 画面の「保存」が既定値まで会社の設定として残していたため、保存したことのある会社には、これらの業務の「0 分」が残っている。
-- 残っていると新しい既定値で推計されないため、これらの業務の「0 分」だけを消す（0 より大きい値は会社が決めた値として残す）。
--
-- 移行のファイルは毎回すべて当て直されるため、一度だけ行う印（m2o_data_fixes）を持つ。
-- 印が無いと、このあと会社が意図して 0 分にした値まで、移行のたびに消してしまう。

create table if not exists m2o_data_fixes (
  id          text primary key,
  applied_at  timestamptz not null default now()
);
revoke all on m2o_data_fixes from public;

do $$
declare
  ids text[] := array[
    'secretary-lookup', 'secretary-plan-report',
    'business-cards:import', 'business-cards:update', 'business-cards:bulk-mail',
    'inventory:record', 'inventory:slip', 'inventory:order',
    'web-columns:draft', 'web-columns:place', 'web-columns:cover', 'web-columns:rules', 'web-columns:signage', 'web-columns:signage-publish',
    'inquiries:record', 'inquiries:lookup', 'inquiries:reply-draft', 'inquiries:reply-send',
    'competitors:find', 'competitors:analyze',
    'announcements:draft', 'announcements:publish',
    'web-review:ask', 'web-review:request',
    'contracts:ledger', 'subsidies:guide', 'members:desk', 'members:line-send', 'print-designs:desk',
    'jp.m2office.legal.contract-review:contract-review',
    'jp.m2office.samples.research-slides:research-slides',
    'jp.m2office.samples.deepwiki-research:research'
  ];
  k text;
begin
  if exists (select 1 from m2o_data_fixes where id = 'effect-zero-defaults-0.316') then return; end if;
  foreach k in array ids loop
    update tenant_settings
       set effect = jsonb_set(effect, '{minutesPerRun}', (effect->'minutesPerRun') - k)
     where effect ? 'minutesPerRun' and (effect->'minutesPerRun'->>k)::numeric = 0;
  end loop;
  insert into m2o_data_fixes (id) values ('effect-zero-defaults-0.316');
end $$;
