/**
 * @file 運営者を作る（仕様書 第23.8.15節）。最初の運営管理者を作るための、運営の手元のツール。2 人目からはマスター管理画面で足す。
 *
 * 使い方:
 *   npm run ops:operator -- --email someone@example.com --name "名前" --role admin
 *   npm run ops:operator -- --email someone@example.com --code             # 登録の合言葉を出し直す
 *   npm run ops:operator -- --email someone@example.com --reset-passkeys   # パスキーを削除して合言葉を出す（最後の運営管理者がなくしたとき）
 *
 * 作ったときは、パスキーの登録の合言葉（1 回だけ・24 時間）を出す。本人に別の手段で渡す。
 * すでにあるメールアドレスなら、運営者は作り直さない。ロールは admin（運営管理者）・support（サポート）・monitor（監視）。
 */

import pg from 'pg';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** `--key value` の形の引数を読む。値の無い `--code` などは true。 */
function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i]?.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[argv[i].slice(2)] = true;
    else { out[argv[i].slice(2)] = next; i++; }
  }
  return out;
}

/** 登録の合言葉（マスター管理画面と同じ形。読み違えにくい字で 4 字ずつ 3 組）。SHA-256 だけを持つ。 */
async function issueCode(c, operatorId) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const s = [...randomBytes(12)].map((b) => chars[b % chars.length]).join('');
  const code = `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
  await c.query(
    `insert into ops.enroll_codes (operator_id, code_hash, expires_at, created_by) values ($1,$2, now() + interval '24 hours','ops:operator')
     on conflict (operator_id) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at, created_by = excluded.created_by, created_at = now()`,
    [operatorId, createHash('sha256').update(code).digest('hex')],
  );
  return code;
}

const a = args(process.argv.slice(2));
const email = String(a.email ?? '').trim().toLowerCase();
const name = String(a.name ?? '').trim() || email.split('@')[0];
const role = String(a.role ?? 'admin').trim();
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
    const found = (await c.query('select id from ops.operators where email = $1', [email])).rows[0];
    if (a['reset-passkeys']) {
      await c.query('delete from ops.passkeys where operator_id = $1', [found.id]);
      await c.query('update ops.sessions set revoked_at = now() where operator_id = $1 and revoked_at is null', [found.id]);
      await c.query(`insert into ops.audit (id, operator_id, action, target_type, target_id) values ($1,'ops:operator','operator.reset_passkeys','operator',$2)`, [randomUUID(), found.id]);
      console.log(`パスキーを削除しました: ${email}`);
    }
    if (a.code || a['reset-passkeys']) {
      const code = await issueCode(c, found.id);
      await c.query(`insert into ops.audit (id, operator_id, action, target_type, target_id) values ($1,'ops:operator','operator.enroll_code','operator',$2)`, [randomUUID(), found.id]);
      console.log(`パスキーの登録の合言葉（24 時間・1 回だけ）: ${code}`);
    } else {
      console.log(`すでにあります: ${email}。何も変えませんでした（合言葉を出し直すときは --code）。`);
    }
  } else {
    await c.query(`insert into ops.audit (id, operator_id, action, target_type, target_id, detail) values ($1,'ops:operator','operator.add','operator',$2,$3)`,
      [randomUUID(), rows[0].id, JSON.stringify({ email, role })]);
    const code = await issueCode(c, rows[0].id);
    console.log(`作りました: ${email}（${role}）`);
    console.log(`パスキーの登録の合言葉（24 時間・1 回だけ）: ${code}`);
    console.log('本人に別の手段で渡してください。Google でログインしたあと、この合言葉でパスキーを登録します。');
    console.log(`開発では http://ops.lvh.me:${process.env.WEB_PORT ?? 3100} から入れます（開発用ログインではパスキーを求めません）。`);
  }
} catch (err) {
  console.error('作れませんでした:', err instanceof Error ? err.message : err, '（npm run db:migrate を済ませてください）');
  process.exit(1);
} finally {
  await c.end();
}
