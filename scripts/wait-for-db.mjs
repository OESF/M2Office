/**
 * @file データベースが接続を受け付けるまで待つ。`npm run db:up` から呼ばれる。
 */

import { execSync } from 'node:child_process';

const DEADLINE = Date.now() + 60_000;
process.stdout.write('データベースの起動を待っています');
for (;;) {
  try {
    execSync('docker compose exec -T db pg_isready -U m2office', { stdio: 'ignore' });
    console.log('\nデータベースの準備ができました。');
    process.exit(0);
  } catch {
    if (Date.now() > DEADLINE) {
      console.error('\nデータベースが起動しませんでした。docker compose logs db を確認してください。');
      process.exit(1);
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 1000));
  }
}
