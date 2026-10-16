/**
 * @file ローカルの形の「機械の管理者」（仕様書 第8.6.3節、Q-154）。
 *
 * インターネットや Google が止まっても機械の様子を見られるよう、Google のログインとは別に、機械の管理だけに使う社内の管理者を 1 人持つ。
 * ID・合言葉・2 段階の確かめ（認証アプリの 6 桁の確認コード。TOTP）で入り、業務の画面には入れない。
 * 合言葉の控え（scrypt）と確認コードの種は導入のときに機械の上で作り、`m2office.env` にだけ置く（運営は知らない）。
 * ログイン状態はデータベースに置かず、署名した値を Cookie に持つ（データベースが止まっても機械の様子を見られるように）。
 */

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** 機械の管理者の設定。 */
export interface MachineAdminConfig {
  id: string;
  /** 合言葉の控え（`scrypt:N:r:p:塩:値`。塩と値は base64url）。 */
  passwordHash: string;
  /** 確認コードの種（base32）。 */
  totpSecret: string;
}

/** ログイン状態の長さ（ミリ秒）。機械の確かめに要る時間に限る。 */
export const MACHINE_ADMIN_SESSION_MS = 8 * 3_600_000;
/** 続けて間違えてよい回数。超えたら {@link MACHINE_ADMIN_LOCK_MS} のあいだ受け付けない。 */
export const MACHINE_ADMIN_MAX_FAILURES = 5;
/** 間違いが続いたときに受け付けない長さ（ミリ秒）。 */
export const MACHINE_ADMIN_LOCK_MS = 15 * 60_000;
/** 機械の管理者として記録に残す ID（会社の利用者とぶつからない名前）。 */
export const MACHINE_ADMIN_ACTOR = 'machine-admin';

/**
 * 環境変数から機械の管理者の設定を読む。3 つがそろっていなければ `null`（機械の管理者は使えない）。
 *
 * @remarks 値は `M2O_MACHINE_ADMIN_ID`・`M2O_MACHINE_ADMIN_PASSWORD_HASH`・`M2O_MACHINE_ADMIN_TOTP`（setup.sh が作る）
 */
export function machineAdminFromEnv(env: NodeJS.ProcessEnv = process.env): MachineAdminConfig | null {
  const id = env['M2O_MACHINE_ADMIN_ID']?.trim();
  const passwordHash = env['M2O_MACHINE_ADMIN_PASSWORD_HASH']?.trim();
  const totpSecret = env['M2O_MACHINE_ADMIN_TOTP']?.trim().replace(/\s+/g, '').toUpperCase();
  if (!id || !passwordHash?.startsWith('scrypt:') || !totpSecret || base32Decode(totpSecret).length < 10) return null;
  return { id, passwordHash, totpSecret };
}

/** 合言葉の控えを作る（scrypt）。setup.sh の道具と同じ形。 */
export function hashMachinePassword(password: string, salt: Buffer = randomBytes(16)): string {
  const [N, r, p] = [16384, 8, 1];
  const out = scryptSync(password.normalize('NFKC'), salt, 32, { N, r, p });
  return `scrypt:${N}:${r}:${p}:${salt.toString('base64url')}:${out.toString('base64url')}`;
}

/** 合言葉が控えと合うか（時間を一定にして比べる）。読めない控えは合わないとする。 */
export function verifyMachinePassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (!(N >= 1024 && N <= 1 << 20 && r >= 1 && r <= 32 && p >= 1 && p <= 16)) return false;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const want = Buffer.from(parts[5]!, 'base64url');
  if (salt.length < 8 || want.length < 16) return false;
  const got = scryptSync(password.normalize('NFKC'), salt, want.length, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 });
  return timingSafeEqual(got, want);
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** base32（RFC 4648。埋め草なし）に書く。 */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** base32 を読む。読めない字は飛ばす。 */
export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.toUpperCase().replace(/=+$/, '')) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** 30 秒ごとの刻みでの 6 桁の確認コード（RFC 6238。SHA-1）。 */
export function totpCode(secret: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = mac[mac.length - 1]! & 15;
  const n = (mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, '0');
}

/**
 * 確認コードを確かめる。時計のずれを見て前後 1 刻み（30 秒）まで受ける。
 *
 * @param usedStep 前に使った刻み。それより前の刻みのコードは受けない（同じコードを 2 回使わせない）
 * @returns 合った刻み。合わなければ `null`
 */
export function verifyTotp(secret: string, code: string, now: Date, usedStep = -1): number | null {
  const c = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(now.getTime() / 30_000);
  for (const s of [step - 1, step, step + 1]) {
    if (s <= usedStep) continue;
    if (timingSafeEqual(Buffer.from(totpCode(secret, s)), Buffer.from(c))) return s;
  }
  return null;
}

/** 認証アプリに入れる URI（QR にもできる）。 */
export function totpUri(secret: string, account: string, issuer = 'M2Office'): string {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/**
 * ログイン状態に署名する鍵。サーバーの秘密の鍵と、合言葉の控え・確認コードの種から作る。
 * 合言葉か種を作り直すと鍵が変わり、それまでのログイン状態はすべて使えなくなる。
 */
export function machineSessionKey(serverSecret: string, cfg: MachineAdminConfig): Buffer {
  return createHash('sha256').update(`machine-admin|${serverSecret}|${cfg.id}|${cfg.passwordHash}|${cfg.totpSecret}`).digest();
}

/** ログイン状態を作る。`<期限のミリ秒>.<乱数>.<署名>`。 */
export function issueMachineSession(key: Buffer, now: Date = new Date()): { token: string; expiresAt: string } {
  const exp = now.getTime() + MACHINE_ADMIN_SESSION_MS;
  const body = `${exp}.${randomBytes(16).toString('base64url')}`;
  return { token: `${body}.${sign(key, body)}`, expiresAt: new Date(exp).toISOString() };
}

/**
 * ログイン状態を確かめる。
 *
 * @returns 期限（ISO）。署名が違う・期限を過ぎたら `null`
 */
export function verifyMachineSession(key: Buffer, token: string | undefined, now: Date = new Date()): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const body = `${parts[0]}.${parts[1]}`;
  const want = Buffer.from(sign(key, body));
  const got = Buffer.from(parts[2]!);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const exp = Number(parts[0]);
  if (!Number.isFinite(exp) || exp <= now.getTime() || exp > now.getTime() + MACHINE_ADMIN_SESSION_MS) return null;
  return new Date(exp).toISOString();
}

/** ログイン状態に結び付いた CSRF の印（状態を変える要求に添えさせる）。 */
export function machineCsrf(key: Buffer, token: string): string {
  return sign(key, `csrf|${token}`);
}

const sign = (key: Buffer, body: string) => createHmac('sha256', key).update(body).digest('base64url');

/**
 * ログインの間違いを数え、続いたら受け付けない（総当たりを防ぐ）。プロセスの中だけで数える。
 *
 * @remarks 送り元ごとと、機械の管理者全体（送り元を変えた総当たり）の両方で数える
 */
export class MachineLoginThrottle {
  private readonly failures = new Map<string, { count: number; first: number; lockedUntil: number }>();
  /** 前に使った確認コードの刻み（同じコードを 2 回使わせない）。 */
  usedStep = -1;

  /** いま受け付けないなら、受け付けるまでの残りの秒。受け付けるなら `0`。 */
  lockedFor(key: string, now: number = Date.now()): number {
    const left = Math.max(this.left('*', now), this.left(key, now));
    return Math.ceil(left / 1000);
  }

  /** 間違いを 1 回数える。 */
  fail(key: string, now: number = Date.now()): void {
    for (const k of [key, '*']) {
      const max = k === '*' ? MACHINE_ADMIN_MAX_FAILURES * 4 : MACHINE_ADMIN_MAX_FAILURES;
      const cur = this.failures.get(k);
      const f = cur && now - cur.first < MACHINE_ADMIN_LOCK_MS ? cur : { count: 0, first: now, lockedUntil: 0 };
      f.count++;
      if (f.count >= max) { f.lockedUntil = now + MACHINE_ADMIN_LOCK_MS; f.count = 0; f.first = now; }
      this.failures.set(k, f);
    }
  }

  /** 入れたら、その送り元の数を消す。 */
  succeed(key: string): void {
    this.failures.delete(key);
  }

  private left(key: string, now: number): number {
    const f = this.failures.get(key);
    return f ? Math.max(0, f.lockedUntil - now) : 0;
  }
}
