/**
 * @file 運営者を作る（仕様書 第23.8.15節）。最初の運営管理者を作るための、運営の手元のツール。2 人目からはマスター管理画面で足す。
 *
 * 使い方:
 *   npm run ops:operator -- --email someone@example.com --name "名前" --role admin
 *
 * すでにあるメールアドレスなら、何も変えずに終わる。ロールは admin（運営管理者）・support（サポート）・monitor（監視）。
 */

import pg from 'pg';
import { randomUUID } from 'node:crypto';

/** `--key value` の形の引数を読む。 */
function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) if (argv[i]?.startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] ?? '';
  return out;
}

const a = args(process.argv.slice(2));
const email = (a.email ?? '').trim().toLowerCase();
const name = (a.name ?? '').trim() || email.split('@')[0];
const role = (a.role ?? 'admin').trim();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !['admin', 'support', 'monitor'].includes(role)) {
  console.error('使い方: npm run ops:operator -- --email someone@example.com --name "名前" --role admin|support|monitor');
  process.exit(1);
}

// 運営の表を作るため、所有者のロールで接続する（運営のロールには運営者を作る前の入口が無い）
const c = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL ?? 'postgres://m2office:m2office@localhost:3105/m2office' });
await c.connect();
try {
  const { rows } = await c.query(
    `insert into ops.operators (id, email, display_name, role, created_by) values ($1,$2,$3,$4,'ops:operator')
     on conflict (email) do nothing returning id`,
    [`op-${randomUUID().slice(0, 12)}`, email, name, role],
  );
  if (rows.length === 0) {
    console.log(`すでにあります: ${email}。何も変えませんでした。`);
  } else {
    await c.query(`insert into ops.audit (id, operator_id, action, target_type, target_id, detail) values ($1,'ops:operator','operator.add','operator',$2,$3)`,
      [randomUUID(), rows[0].id, JSON.stringify({ email, role })]);
    console.log(`作りました: ${email}（${role}）`);
    console.log(`開発では http://ops.lvh.me:${process.env.WEB_PORT ?? 3100} から入れます。`);
  }
} catch (err) {
  console.error('作れませんでした:', err instanceof Error ? err.message : err, '（npm run db:migrate を済ませてください）');
  process.exit(1);
} finally {
  await c.end();
}
