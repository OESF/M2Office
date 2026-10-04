-- 競合の分析の地図の鍵（仕様書 第36.18節。第 0.237.0 版）
-- 後の移行が種類を足すため、ここでは古い行を確かめない（not valid。最後の移行 079 が確かめる）
-- Google Cloud コンソールで作った API キーを、会社の鍵の置き場に暗号化して置く（AI Studio の新しい形の Gemini の鍵は Places API に使えないため）
alter table tenant_credentials drop constraint if exists tenant_credentials_kind_check;
alter table tenant_credentials add constraint tenant_credentials_kind_check check (kind in ('gemini', 'google_oauth', 'wordpress', 'inquiry_mailbox', 'line', 'places')) not valid;
