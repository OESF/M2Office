/**
 * @file 暗号の鍵の入れ替え（仕様書 第16.11.3節 G-10）。前の鍵で暗号化した値を、今の鍵で暗号化し直す。
 *
 * 手順（第16.11.3節）:
 *   1. 新しい鍵を作る（`openssl rand -base64 32`）
 *   2. 設定の `M2OFFICE_SECRET_KEY` を新しい鍵にし、前の鍵を `M2OFFICE_SECRET_KEY_OLD` に移す（カンマで複数）
 *   3. API とワーカーを起動し直す（前の鍵でも読めるので、止めずに続けられる）
 *   4. `npm run secrets:rotate` で残りを暗号化し直す（`--check` は数えるだけ）
 *
 * 暗号化した値を持つ列（7 つ）を、データベースの所有者のつなぎ（`MIGRATION_DATABASE_URL`）で全社分読む。
 * 今の鍵で読める値は変えない。どの鍵でも読めない値は変えずに数えて示す（推測で直さない）。
 * 暗号の形（AES-256-GCM・`v1:IV:タグ:本文`）は `packages/core/src/secrets/box.ts` と同じ。単体テストで両者が読み合えることを確かめる。
 *
 * 使い方:
 *   npm run secrets:rotate            # 暗号化し直す
 *   npm run secrets:rotate -- --check # 数えるだけ
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** 暗号化した値を持つ列（表・主キー・列）。新しく足したら、ここにも足す。 */
export const SEALED_COLUMNS = [
  { table: 'tenant_credentials', column: 'secret_enc' },
  { table: 'user_google_connections', column: 'refresh_token_enc' },
  { table: 'connection_secrets', column: 'client_secret_enc' },
  { table: 'connection_secrets', column: 'api_key_enc' },
  { table: 'user_connections', column: 'access_token_enc' },
  { table: 'user_connections', column: 'refresh_token_enc' },
  { table: 'canva_connections', column: 'refresh_token_enc' },
  // 外部のアプリからの配信（第13.4.4節。移行 157）
  { table: 'delivery_recipients', column: 'contact_enc' },
  { table: 'delivery_stops', column: 'email_enc' },
];

/** 設定の文字列を 32 バイトの鍵にする（box.ts と同じ）。 */
export function keyOf(secret) {
  const raw = Buffer.from(secret, 'base64');
  return raw.length === 32 && /^[A-Za-z0-9+/=]+$/.test(secret) ? raw : createHash('sha256').update(secret).digest();
}

/** 今の鍵で暗号化する（box.ts と同じ形）。 */
export function seal(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':');
}

/** 鍵を順に試して読む。読めなければ `null`。`index` は読めた鍵の順番（0 が今の鍵）。 */
export function unseal(keys, sealed) {
  const [version, iv, tag, body] = String(sealed).split(':');
  if (version !== 'v1' || !iv || !tag || !body) return null;
  for (const [index, key] of keys.entries()) {
    try {
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return { plaintext: Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8'), index };
    } catch {
      // 次の鍵を試す
    }
  }
  return null;
}

/**
 * 1 つの値をどうするかを決める。
 *
 * @returns `keep`（今の鍵で読める）・`reseal`（前の鍵で読めた。新しい暗号文つき）・`unreadable`（どの鍵でも読めない）
 */
export function decide(keys, sealed) {
  const r = unseal(keys, sealed);
  if (!r) return { action: 'unreadable' };
  if (r.index === 0) return { action: 'keep' };
  return { action: 'reseal', sealed: seal(keys[0], r.plaintext) };
}

async function main() {
  const check = process.argv.includes('--check');
  // 開発では、API とワーカーと同じ開発用の固定の鍵を使う（box.ts と同じ。本番では設定が要る）
  const current = process.env['M2OFFICE_SECRET_KEY'] || (process.env['NODE_ENV'] === 'production' ? '' : 'm2office-development-only-secret-key');
  if (!current) {
    console.error('M2OFFICE_SECRET_KEY が設定されていません');
    process.exit(1);
  }
  const keys = [keyOf(current), ...(process.env['M2OFFICE_SECRET_KEY_OLD'] ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(keyOf)];
  const { default: pg } = await import('pg');
  // 全社分を読むため、行レベルセキュリティの外にいる所有者のつなぎを使う（アプリのつなぎでは会社の行が見えない）
  if (process.env['NODE_ENV'] === 'production' && !process.env['MIGRATION_DATABASE_URL']) {
    console.error('本番では MIGRATION_DATABASE_URL を設定してください');
    process.exit(1);
  }
  const url = process.env['MIGRATION_DATABASE_URL'] ?? 'postgres://m2office:m2office@localhost:3105/m2office';
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  const total = { keep: 0, reseal: 0, unreadable: 0 };
  try {
    for (const { table, column } of SEALED_COLUMNS) {
      const exists = await db.query('select 1 from information_schema.columns where table_name = $1 and column_name = $2', [table, column]);
      if (exists.rowCount === 0) continue;
      const { rows } = await db.query(`select ctid::text as row_id, ${column} as v from ${table} where ${column} is not null`);
      const n = { keep: 0, reseal: 0, unreadable: 0 };
      for (const r of rows) {
        const d = decide(keys, r.v);
        n[d.action]++;
        // 同じ行が書き換わっていれば（値が変わっていれば）触らない
        if (d.action === 'reseal' && !check) await db.query(`update ${table} set ${column} = $1 where ctid = $2::tid and ${column} = $3`, [d.sealed, r.row_id, r.v]);
      }
      for (const k of Object.keys(total)) total[k] += n[k];
      console.log(`${table}.${column}: 今の鍵 ${n.keep}・${check ? '暗号化し直す' : '暗号化し直した'} ${n.reseal}・読めない ${n.unreadable}`);
    }
  } finally {
    await db.end();
  }
  console.log(`合計: 今の鍵 ${total.keep}・${check ? '暗号化し直す' : '暗号化し直した'} ${total.reseal}・読めない ${total.unreadable}`);
  if (total.unreadable > 0) {
    console.error('どの鍵でも読めない値があります。前の鍵を M2OFFICE_SECRET_KEY_OLD に入れ忘れていないか確かめてください（値は変えていません）');
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`鍵の入れ替えに失敗しました: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
