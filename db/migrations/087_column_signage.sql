-- コラムから店頭サイネージ用の画像（紙芝居）と動画を作る（仕様書 第32.18.6節。第 0.256.0 版）
-- 1 組 = 1 回の「サイネージ用を作る」。作る → 承認へ → 流す → 外す、の状態を持つ
create table if not exists column_signage (
  tenant_id     text not null references tenants(id) on delete cascade,
  id            text primary key,
  column_id     text not null,
  -- 'slides'（画像。1 枚か紙芝居）か 'video'（動画。段 2）
  kind          text not null check (kind in ('slides', 'video')),
  -- making（作っている）・ready（できた）・submitted（承認待ち）・published（流している）・withdrawn（外した）・failed（作れなかった）
  status        text not null default 'making' check (status in ('making', 'ready', 'submitted', 'published', 'withdrawn', 'failed')),
  -- 場面（一言と絵の内容）。一言は画面に出す文
  scenes        jsonb not null default '[]'::jsonb,
  -- できた画像・動画（向きと順番とファイルの ID）
  outputs       jsonb not null default '[]'::jsonb,
  -- 描いた絵の数（カバーと同じ月の上限に数える。確かめを通らなかった分も含む）
  ai_attempts   integer not null default 0,
  note          text not null default '',
  error         text,
  run_id        text,
  -- 承認したときの中身の印（承認の後に作り直したものは流さない）
  digest        text,
  -- 流した画面と、足した素材
  screen_ids    text[] not null default '{}',
  asset_ids     text[] not null default '{}',
  publish_until timestamptz,
  created_by    text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists column_signage_column on column_signage (tenant_id, column_id, created_at desc);
-- ワーカーが作り始めた日時（同じ組を二重に作らない。止まったまま古くなれば受け持ち直す）
alter table column_signage add column if not exists claimed_at timestamptz;

alter table column_signage enable row level security;
drop policy if exists tenant_isolation on column_signage;
create policy tenant_isolation on column_signage
  using (tenant_id = m2o_current_tenant())
  with check (tenant_id = m2o_current_tenant());

grant select, insert, update, delete on column_signage to m2office_app;

-- 店頭の画面が動画の下に重ねて出す字幕（段 2。生成 AI に字を描かせないため）
alter table signage_assets add column if not exists caption text;
