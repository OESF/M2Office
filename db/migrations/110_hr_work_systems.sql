-- 1 年単位の変形労働時間制・フレックスタイム制・共有の端末での打刻（仕様書 第30.6.3節、ADR-0085、Q-130。第 0.302.0 版）。
-- 働き方に「1 年単位の変形労働時間制」「フレックスタイム制」を足す。会社の決まりは tenant_settings の hr に持つ（列は足さない）。
-- 共有の端末は、店頭サイネージと同じく、端末に出た番号を人事区画の人が登録する。端末の鍵は SHA-256 のハッシュだけを持つ。
-- 名前と 4 桁の番号での打刻（会社が許したときだけ）の番号は、scrypt のハッシュだけを持つ。

alter table hr_terms drop constraint if exists hr_terms_schedule_check;
alter table hr_terms add constraint hr_terms_schedule_check check (schedule in ('fixed', 'shift', 'annual', 'flex'));

-- どの端末で打ったか
alter table att_punches drop constraint if exists att_punches_source_check;
alter table att_punches add constraint att_punches_source_check check (source in ('screen', 'mobile', 'secretary', 'fix', 'import', 'terminal'));
alter table att_punches add column if not exists terminal_id text;

-- 共有の端末
create table if not exists hr_terminals (
  id             text primary key,
  tenant_id      text not null references tenants(id) on delete cascade,
  name           text not null check (char_length(name) between 1 and 20),
  key_hash       text unique,
  status         text not null default 'active' check (status in ('active', 'removed')),
  last_seen_at   timestamptz,
  registered_by  text not null,
  registered_at  timestamptz not null default now(),
  removed_by     text,
  removed_at     timestamptz
);
create index if not exists hr_terminals_tenant_idx on hr_terminals (tenant_id) where status = 'active';

-- 登録を待つ番号（10 分で切れる。鍵を渡したら消す）
create table if not exists hr_terminal_pairings (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  code         text not null check (code ~ '^[0-9]{6}$'),
  secret_hash  text not null,
  expires_at   timestamptz not null,
  terminal_id  text references hr_terminals(id) on delete cascade,
  created_at   timestamptz not null default now()
);
create index if not exists hr_terminal_pairings_code on hr_terminal_pairings (tenant_id, code);

-- 名前と番号での打刻の番号（本人が個人設定で決める）。5 回間違えたら 15 分止める
create table if not exists hr_punch_pins (
  tenant_id     text not null references tenants(id) on delete cascade,
  employee_id   text not null references hr_employees(id) on delete cascade,
  pin_hash      text not null,
  failures      integer not null default 0,
  locked_until  timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (tenant_id, employee_id)
);

do $$
declare t text;
begin
  foreach t in array array['hr_terminals', 'hr_terminal_pairings', 'hr_punch_pins'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
  end loop;
end $$;
grant select, insert, update, delete on hr_terminals, hr_terminal_pairings, hr_punch_pins to m2office_app;
