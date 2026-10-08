/**
 * @file データベースのスキーマ変更（`db/migrations` の SQL）を順に適用する。
 *
 * スキーマ変更は所有者のロール（`MIGRATION_DATABASE_URL`）で行う。
 * アプリが使うロール（`m2office_app`）が無ければ先に作る。
 * アプリのロールは表の所有者にせず、行レベルセキュリティを迂回させない。
 *
 * @see 仕様書 第8.5.5節 RLS 実装上の注意
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const OWNER_URL = process.env.MIGRATION_DATABASE_URL ?? 'postgres://m2office:m2office@localhost:3105/m2office';
const APP_URL = process.env.DATABASE_URL ?? 'postgres://m2office_app:m2office_app@localhost:3105/m2office';
const APP_ROLE = 'm2office_app';

const client = new pg.Client({ connectionString: OWNER_URL });
await client.connect();

// アプリのロールを用意する。名前は SQL 側の権限付与と揃えて固定する
const app = new URL(APP_URL);
if (decodeURIComponent(app.username) !== APP_ROLE) {
  console.error(`DATABASE_URL の利用者は ${APP_ROLE} にしてください（現在: ${app.username}）。`);
  console.error('所有者のロールで接続すると、行レベルセキュリティが効きません。');
  process.exit(1);
}
const { rows } = await client.query('select 1 from pg_roles where rolname = $1', [APP_ROLE]);
if (rows.length === 0) {
  const password = decodeURIComponent(app.password).replace(/'/g, "''");
  await client.query(`create role ${APP_ROLE} login nosuperuser nobypassrls password '${password}'`);
  console.log(`ロールを作成しました: ${APP_ROLE}`);
}

const dir = join(import.meta.dirname, '..', 'db', 'migrations');
for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  process.stdout.write(`適用: ${file} ... `);
  await client.query(readFileSync(join(dir, file), 'utf8'));
  console.log('完了');
}
// 運営の画面のロール（仕様書 第23.8.15節、移行 111）。移行は NOLOGIN で作る。OPS_DATABASE_URL があればその合言葉でログインできるようにする。
// 開発では既定の合言葉を使う。本番で OPS_DATABASE_URL が無ければログインできないまま（ローカルの形には運営の画面を入れない）
const opsUrl = process.env.OPS_DATABASE_URL ?? (process.env.NODE_ENV === 'production' ? null : 'postgres://m2office_ops:m2office_ops@localhost:3105/m2office');
if (opsUrl) {
  const ops = new URL(opsUrl);
  if (decodeURIComponent(ops.username) !== 'm2office_ops') {
    console.error(`OPS_DATABASE_URL の利用者は m2office_ops にしてください（現在: ${ops.username}）。`);
    process.exit(1);
  }
  await client.query(`alter role m2office_ops login password '${decodeURIComponent(ops.password).replace(/'/g, "''")}'`);
}
await client.end();
console.log('マイグレーションが完了しました。');
