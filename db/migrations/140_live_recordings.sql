-- その場で録音する入口（仕様書 第9.4.5.1節。第 0.372.0 版。ADR-0099）
--
-- 画面で録っている途中の録音。画面は 10 秒ごとに欠片（16 kHz・モノラル・16 ビットの PCM）を送り、止めたときにサーバーが 1 つの WAV にする。
-- 欠片の中身はファイルの置き場に置き、ここには番号と大きさだけを持つ。録った本人だけが扱い、1 人 1 つまで。
-- 止めずに 1 日たったものはワーカーが消す（録音は残さない。第10.5.3節）。
create table if not exists live_recordings (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  user_id     text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, user_id)
);
create index if not exists live_recordings_updated_idx on live_recordings (tenant_id, updated_at);

create table if not exists live_recording_parts (
  recording_id  text not null references live_recordings(id) on delete cascade,
  tenant_id     text not null references tenants(id) on delete cascade,
  seq           integer not null check (seq >= 0),
  size          integer not null check (size >= 0),
  primary key (recording_id, seq)
);

do $$
declare t text;
begin
  foreach t in array array['live_recordings', 'live_recording_parts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
    execute format('grant select, insert, update, delete on %I to m2office_app', t);
  end loop;
end $$;
