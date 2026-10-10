-- 外部のアプリの機能を足す（仕様書 第11.12節・第13.4.2節、ADR-0089・ADR-0090。第 0.328.0 版）
--
-- アカウントの結び付け（確認コードと結び付き）、アプリが入れた記録の控え（予約・お知らせ・業務の実行。アプリが入れたものだけを
-- 取り消せる・読めるようにするため）、入庫の通知、アプリが出すお知らせ（出した人を利用者に限らない）。
-- 確認コードと結び付きの ID はハッシュだけを持つ。依頼のメールアドレスは持たない。ナレッジの検索の質問と答えの文は持たない。

-- 結び付けの依頼（アプリと本人ごとに 1 つ。依頼し直すと前のコードは使えなくなる）
create table if not exists ext_app_link_requests (
  tenant_id   text not null references tenants(id) on delete cascade,
  app_id      text not null references ext_apps(id) on delete cascade,
  user_id     text not null,
  code_hash   text not null,
  -- 確定で試した回数（5 回を超えたら、そのコードは使えない）
  attempts    integer not null default 0,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, app_id, user_id)
);

-- 結び付き（アプリの利用者と M2Office の利用者）。アプリを削除すると消える
create table if not exists ext_app_bindings (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  app_id        text not null references ext_apps(id) on delete cascade,
  user_id       text not null,
  binding_hash  text not null unique,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index if not exists ext_app_bindings_user_idx on ext_app_bindings (tenant_id, user_id);

-- アプリが入れた記録の控え（kind: reservation・notice・run）。アプリは自分が入れたものだけを取り消せる・読める
create table if not exists ext_app_refs (
  tenant_id   text not null references tenants(id) on delete cascade,
  app_id      text not null references ext_apps(id) on delete cascade,
  kind        text not null,
  ref         text not null,
  created_at  timestamptz not null default now(),
  primary key (tenant_id, app_id, kind, ref)
);

-- 入庫の通知（アプリ＋入荷の番号で 1 件）。入庫の記録を持ち、取り消しで戻す
create table if not exists inventory_app_receipts (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  app_id       text not null references ext_apps(id) on delete cascade,
  receipt_ref  text not null,
  status       text not null check (status in ('received', 'cancelled')),
  -- 入庫の記録の組ごとに中の記録 1 つの ID
  moves        jsonb not null default '[]',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, app_id, receipt_ref)
);

-- 照らせなかった行に、入荷の入庫を足す（販売の行と同じ画面で品目を選ぶ）
alter table inventory_sale_unmatched alter column sale_id drop not null;
alter table inventory_sale_unmatched add column if not exists receipt_id text references inventory_app_receipts(id) on delete cascade;
alter table inventory_sale_unmatched drop constraint if exists inventory_sale_unmatched_action_check;
alter table inventory_sale_unmatched add constraint inventory_sale_unmatched_action_check check (action in ('hold', 'use', 'return', 'receive'));

-- 外部のアプリが出したお知らせは、出した人が `app:<アプリ>` になる（利用者の表に無い）
alter table notices drop constraint if exists notices_author_id_fkey;

do $$ declare t text; begin
  foreach t in array array['ext_app_link_requests', 'ext_app_bindings', 'ext_app_refs', 'inventory_app_receipts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = m2o_current_tenant()) with check (tenant_id = m2o_current_tenant())', t);
  end loop; end $$;

grant select, insert, update, delete on ext_app_link_requests, ext_app_bindings, ext_app_refs, inventory_app_receipts to m2office_app;
