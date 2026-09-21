/** `db/migrations` の SQL を順に適用する。 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL ?? 'postgres://m2office:m2office@localhost:3105/m2office';
const client = new pg.Client({ connectionString: url });
await client.connect();

const dir = join(import.meta.dirname, '..', 'db', 'migrations');
for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  process.stdout.write(`適用: ${file} ... `);
  await client.query(readFileSync(join(dir, file), 'utf8'));
  console.log('完了');
}
await client.end();
console.log('マイグレーションが完了しました。');
