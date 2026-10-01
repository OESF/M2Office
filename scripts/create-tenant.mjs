/**
 * @file 会社（テナント）と最初の管理者を作る（仕様書 第16.1.3節）。
 *
 * セルフサインアップ（Phase 3）とマスター管理画面（第23章）ができるまでの、
 * 運営の手元のツールである。画面からは行えない。
 *
 * 使い方:
 *   npm run tenant:create -- --subdomain oesf --name "会社名" --domain oesf.jp --admin miura@oesf.jp
 *
 * すでにあるサブドメインなら、何も変えずに終わる（何度実行しても同じ結果になる）。
 */

import pg from 'pg';
import { randomUUID } from 'node:crypto';

/** 運営が使う名前は払い出さない（仕様書 第20.4.3節）。API の RESERVED と同じもの。 */
const RESERVED = new Set([
  'www', 'api', 'app', 'admin', 'ops', 'mail', 'docs', 'status', 'help', 'localhost',
]);

/** サブドメインの規則（仕様書 第20.4.3節）。英小文字・数字・ハイフン。先頭と末尾のハイフンは不可。最小 3 文字。 */
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;

/** `--key value` の形の引数を読む。 */
function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k?.startsWith('--')) continue;
    out[k.slice(2)] = argv[i + 1] ?? '';
  }
  return out;
}

const a = args(process.argv.slice(2));
const subdomain = (a.subdomain ?? '').trim().toLowerCase();
const name = (a.name ?? '').trim();
const domain = (a.domain ?? '').trim().toLowerCase();
const admin = (a.admin ?? '').trim().toLowerCase();

/** 使い方を示して終わる。 */
function usage(reason) {
  console.error(`エラー: ${reason}\n`);
  console.error('使い方:');
  console.error('  npm run tenant:create -- --subdomain oesf --name "会社名" --domain oesf.jp --admin miura@oesf.jp\n');
  console.error('  --subdomain  会社のサブドメイン（英小文字・数字・ハイフン、3 文字以上）');
  console.error('  --name       会社の名前');
  console.error('  --domain     Google Workspace のドメイン');
  console.error('  --admin      最初の管理者のメールアドレス（--domain に属すること）');
  process.exit(1);
}

if (!subdomain || !name || !domain || !admin) usage('指定が足りません');
if (!SUBDOMAIN.test(subdomain) || subdomain.length < 3) {
  usage('サブドメインは英小文字・数字・ハイフンで、3 文字以上、先頭と末尾をハイフンにできません');
}
if (RESERVED.has(subdomain)) usage(`「${subdomain}」は運営が使う名前のため、払い出せません`);
if (admin.split('@')[1] !== domain) usage(`管理者のメールアドレスは ${domain} のものにしてください`);

// テナントを横断して書くため、所有者のロールで接続する
const url = process.env.MIGRATION_DATABASE_URL ?? 'postgres://m2office:m2office@localhost:3105/m2office';
const c = new pg.Client({ connectionString: url });
await c.connect();

try {
  const existing = await c.query('select id, name from tenants where subdomain = $1', [subdomain]);
  if (existing.rows.length > 0) {
    console.log(`すでにあります: ${subdomain}（${existing.rows[0].name}）。何も変えませんでした。`);
    process.exit(0);
  }
  const dup = await c.query('select subdomain from tenants where workspace_domain = $1', [domain]);
  if (dup.rows.length > 0) {
    // 同じ Workspace のドメインを 2 つの会社に割り当てると、ログインの照合が曖昧になる
    usage(`ドメイン ${domain} は、すでに ${dup.rows[0].subdomain} で使われています`);
  }

  const tenantId = `t-${subdomain}`;
  const userId = `u-${subdomain}-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  await c.query('begin');
  await c.query(
    `insert into tenants (id, subdomain, name, workspace_domain, status)
     values ($1,$2,$3,$4,'active')`,
    [tenantId, subdomain, name, domain],
  );
  await c.query(
    `insert into users (id, tenant_id, email, display_name, roles)
     values ($1,$2,$3,$4,$5)`,
    [userId, tenantId, admin, admin.split('@')[0], ['admin', 'approver', 'member']],
  );
  await c.query(
    `insert into audit_events (id, tenant_id, actor_type, actor_id, action, target_type, target_id, detail, occurred_at)
     values ($1,$2,'system','tenant:create','tenant.create','tenant',$3,$4,$5)`,
    [randomUUID(), tenantId, tenantId, JSON.stringify({ subdomain, domain, admin }), now],
  );
  await c.query('commit');

  console.log(`作りました: ${name}`);
  console.log(`  サブドメイン: ${subdomain}`);
  console.log(`  Workspace のドメイン: ${domain}`);
  console.log(`  最初の管理者: ${admin}（admin・approver・member）`);
  console.log('');
  console.log(`開発では http://${subdomain}.lvh.me:${process.env.WEB_PORT ?? 3100} から入れます。`);
} catch (err) {
  await c.query('rollback').catch(() => undefined);
  console.error('作れませんでした:', err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  await c.end();
}
