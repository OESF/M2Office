/**
 * 開発用の初期データを投入する。
 *
 * テナントを 2 つ作る。1 つだけで開発すると分離の不備に気づけないため
 * （仕様書 第21.4.1節）。
 */
import pg from 'pg';

const url = process.env.DATABASE_URL ?? 'postgres://m2office:m2office@localhost:3105/m2office';
const c = new pg.Client({ connectionString: url });
await c.connect();

const tenants = [
  { id: 't-alpha', sub: 'a', name: '株式会社アルファ商事', domain: 'alpha.example.jp' },
  { id: 't-beta', sub: 'b', name: '株式会社ベータ工業', domain: 'beta.example.jp' },
];

for (const t of tenants) {
  await c.query(
    `insert into tenants (id, subdomain, name, workspace_domain, status)
     values ($1,$2,$3,$4,'active') on conflict (id) do nothing`,
    [t.id, t.sub, t.name, t.domain],
  );
  await c.query(
    `insert into users (id, tenant_id, email, display_name, roles)
     values ($1,$2,$3,$4,$5) on conflict (tenant_id, email) do nothing`,
    [`u-${t.sub}-admin`, t.id, `admin@${t.domain}`, '管理者', ['admin', 'approver', 'member']],
  );
  await c.query(
    `insert into users (id, tenant_id, email, display_name, roles)
     values ($1,$2,$3,$4,$5) on conflict (tenant_id, email) do nothing`,
    [`u-${t.sub}-member`, t.id, `member@${t.domain}`, '一般利用者', ['member']],
  );
  await c.query(
    `insert into compartments (id, tenant_id, name, description)
     values ($1,$2,'hr','人事・労務') on conflict (tenant_id, name) do nothing`,
    [`c-${t.sub}-hr`, t.id],
  );
}

// 組織知識。テナントごとに内容を変え、分離が効いていることを確認しやすくする
const knowledge = [
  ['k-alpha-1', 't-alpha', 'rule', '就業規則（抜粋）',
   '年次有給休暇は、入社から 6 か月継続勤務した従業員に 10 日を付与する。', '就業規則 第32条', null],
  ['k-alpha-2', 't-alpha', 'rule', '経費規程（抜粋）',
   '交通費は実費を精算する。1 件 1 万円を超える場合は事前に稟議を要する。', '経費規程 第5条', null],
  ['k-alpha-3', 't-alpha', 'hr', '給与テーブル（区画内）',
   'この文書は HR 区画に属する。区画外の検索では候補に出ない。', '人事資料', 'hr'],
  ['k-beta-1', 't-beta', 'rule', '就業規則（抜粋）',
   'ベータ工業の有給休暇は、入社から 6 か月で 12 日を付与する。', '就業規則 第28条', null],
];
for (const [id, tid, kind, title, body, source, comp] of knowledge) {
  await c.query(
    `insert into knowledge_items (id, tenant_id, kind, title, body, source, compartment)
     values ($1,$2,$3,$4,$5,$6,$7) on conflict (id) do nothing`,
    [id, tid, kind, title, body, source, comp],
  );
}

await c.end();
console.log('初期データを投入しました。');
console.log('  A 社: http://a.lvh.me:3100  （管理者 admin@alpha.example.jp）');
console.log('  B 社: http://b.lvh.me:3100  （管理者 admin@beta.example.jp）');
