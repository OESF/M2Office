-- Web のコラムの業種を東証の 33 業種のコードにし、当てる表現の決まりを別に持つ（仕様書 第32.18.3節、ADR-0066）
-- 前の業種: general（全般）→ 9999 その他、medical（医療・歯科）・legal（士業）→ 9050 サービス業、health-products（薬局・化粧品・健康食品）→ 3250 医薬品。
-- 当てていた決まりは rules に引き継ぎ、選んだのは AI とする（業種などを変えたときに AI が選び直す）
update tenant_settings
   set web_columns = web_columns
     || jsonb_build_object(
          'industry', case web_columns->>'industry'
                        when 'medical' then '9050' when 'legal' then '9050' when 'health-products' then '3250' else '9999' end,
          'rules', case web_columns->>'industry'
                     when 'medical' then '["medical"]'::jsonb when 'legal' then '["legal"]'::jsonb
                     when 'health-products' then '["health-products"]'::jsonb else '[]'::jsonb end,
          'rulesBy', 'ai')
 where web_columns is not null
   and web_columns ? 'industry'
   and web_columns->>'industry' in ('general', 'medical', 'legal', 'health-products');
