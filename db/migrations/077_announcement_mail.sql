-- お知らせの作成の段 2: メール（仕様書 第35.18節。第 0.244.0 版）
-- 1. お知らせのメールの宛先（名刺管理の連絡先。AI が案を出し、画面で外せる）
alter table announcements add column if not exists mail_contact_ids text[] not null default '{}';
-- 2. 出し先にメールを足す
alter table announcement_outputs drop constraint if exists announcement_outputs_channel_check;
alter table announcement_outputs add constraint announcement_outputs_channel_check check (channel in ('web', 'line', 'signage', 'mail'));
-- 3. まとめてのメールを、窓口のアカウントから送るか（お知らせの作成のメール。Q-178）
alter table bulk_mails add column if not exists from_mailbox boolean not null default false;
