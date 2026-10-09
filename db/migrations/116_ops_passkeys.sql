-- 運営者のパスキー（仕様書 第23.8.15節「運営者のパスキー」、Q-211。第 0.317.0 版）
--
-- Google のログインのあと、ログインのたびにパスキーで確かめる。確かめるまでのログイン状態は verified = false で、
-- 本人とパスキーの操作しかできない。最初の登録は、運営管理者が出す 1 回だけの登録の合言葉（24 時間）で行う。

create table if not exists ops.passkeys (
  -- WebAuthn の資格情報の ID（base64url）
  id            text primary key,
  operator_id   text not null references ops.operators(id) on delete cascade,
  -- 公開鍵（base64url。秘密の値ではない）
  public_key    text not null,
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  name          text not null default '',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index if not exists ops_passkeys_operator on ops.passkeys (operator_id);

-- 登録の合言葉（SHA-256 だけを持つ。1 人に 1 つ。出し直すと前のものは使えない）
create table if not exists ops.enroll_codes (
  operator_id  text primary key references ops.operators(id) on delete cascade,
  code_hash    text not null,
  expires_at   timestamptz not null,
  created_by   text not null,
  created_at   timestamptz not null default now()
);

-- パスキーで確かめたログイン状態か
alter table ops.sessions add column if not exists verified boolean not null default false;

grant select, insert, update, delete on ops.passkeys to m2office_ops;
grant select, insert, update, delete on ops.enroll_codes to m2office_ops;
