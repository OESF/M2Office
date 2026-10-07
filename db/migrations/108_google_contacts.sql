-- 名刺を本人の Google の連絡先に入れる（仕様書 第27.15節、ADR-0084、Q-96。第 0.302.0 版）。
-- M2Office から Google への一方向。連絡先ごと・人ごとに、Google の連絡先の番号と、入れたときの値を持つ
-- （入れたときの値と Google の今の値が違う項目は、人が Google で直したものとして上書きしない）。
-- 行は本人だけが見る（ほかの人が、誰がどの名刺を自分の電話帳に入れたかを見られないように）。

create table if not exists google_contact_links (
  tenant_id      text not null references tenants(id) on delete cascade,
  user_id        text not null,
  -- 名刺を消去したら、この行も消える（Google の連絡先は本人のものなので消さない）
  contact_id     text not null references contacts(id) on delete cascade,
  -- Google の連絡先の番号（people/…）
  resource_name  text not null,
  -- 入れたときの値（項目のまとまりごと）
  pushed         jsonb not null,
  pushed_at      timestamptz not null default now(),
  -- どの時点の連絡先まで Google に写したか（連絡先の updated_at）。これより新しく直されたら写し直す
  synced_at      timestamptz not null,
  -- Google の側で消されていたと分かった時刻。消されたものは入れ直さない（本人が「入れる」を押したら入れ直す）
  gone_at        timestamptz,
  primary key (tenant_id, user_id, contact_id)
);
create index if not exists google_contact_links_contact_idx on google_contact_links (tenant_id, contact_id);

alter table google_contact_links enable row level security;
drop policy if exists tenant_isolation on google_contact_links;
create policy tenant_isolation on google_contact_links
  using (tenant_id = m2o_current_tenant() and user_id = m2o_current_user())
  with check (tenant_id = m2o_current_tenant() and user_id = m2o_current_user());
grant select, insert, update, delete on google_contact_links to m2office_app;

-- 人ごとの設定: 自分が取り込んだ名刺を自動で入れるか（既定は切り）、入れ始めた時刻、ラベルの番号
create table if not exists google_contact_prefs (
  tenant_id      text not null references tenants(id) on delete cascade,
  user_id        text not null,
  auto           boolean not null default false,
  -- 自動を入れた時刻。これより後に取り込んだ名刺だけを自動で入れる（入れる前の名刺をまとめて入れない）
  auto_since     timestamptz,
  -- 「M2Office の名刺」のラベルの番号（contactGroups/…）
  group_name     text,
  updated_at     timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
alter table google_contact_prefs enable row level security;
drop policy if exists tenant_isolation on google_contact_prefs;
create policy tenant_isolation on google_contact_prefs
  using (tenant_id = m2o_current_tenant() and user_id = m2o_current_user())
  with check (tenant_id = m2o_current_tenant() and user_id = m2o_current_user());
grant select, insert, update, delete on google_contact_prefs to m2office_app;
