/**
 * @file 秘密の値（Gemini の鍵・OAuth のクライアント シークレット・リフレッシュ トークン）の暗号化と復号。
 *
 * AES-256-GCM で暗号化する。暗号の鍵はサーバーの設定 `M2OFFICE_SECRET_KEY` に置き、データベースには置かない。
 * データベースが漏れても、値を読めないようにするため。
 *
 * **鍵の入れ替え**（仕様書 第16.11.3節 G-10）: 前の鍵を `M2OFFICE_SECRET_KEY_OLD`（カンマで複数）に置くと、読むときだけ使う。
 * 暗号化はいつも今の鍵で行う。残った値は `npm run secrets:rotate`（`scripts/rotate-secrets.mjs`）が今の鍵で暗号化し直す。
 * 暗号文の形は変えない（`v1:IV:タグ:本文`）。読むときは今の鍵から順に試す（GCM のタグで正しい鍵か分かる）。
 *
 * @see 仕様書 第14.3.3節「保存」
 * @see ADR-0007 接続の設定
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** 暗号文の形式の版。形式を変えるときに古いものを読み分ける。 */
const VERSION = 'v1';

/** 設定の文字列を 32 バイトの鍵にする。32 バイトの Base64 ならそのまま、それ以外の文字列なら SHA-256 で 32 バイトにする。 */
function keyOf(secret: string): Buffer {
  const raw = Buffer.from(secret, 'base64');
  return raw.length === 32 && /^[A-Za-z0-9+/=]+$/.test(secret) ? raw : createHash('sha256').update(secret).digest();
}

/** 秘密の値を暗号化・復号する。 */
export class SecretBox {
  private readonly key: Buffer;
  private readonly oldKeys: Buffer[];

  /**
   * @param secret 今の暗号の鍵（暗号化と復号に使う）
   * @param oldSecrets 前の鍵（復号だけに使う。鍵の入れ替えの途中。第16.11.3節 G-10）
   */
  constructor(secret: string, oldSecrets: string[] = []) {
    this.key = keyOf(secret);
    this.oldKeys = oldSecrets.map((s) => s.trim()).filter(Boolean).map(keyOf).filter((k) => !k.equals(this.key));
  }

  /** 暗号化する。毎回ちがう IV を使うため、同じ値でも暗号文は変わる。 */
  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':');
  }

  /**
   * 復号する。
   *
   * @throws {Error} 形式が違う・鍵が違う・改ざんされている場合
   */
  decrypt(sealed: string): string {
    return this.open(sealed).plaintext;
  }

  /**
   * 復号し、前の鍵で読んだかを返す（鍵の入れ替えで、暗号化し直す値を見分ける）。
   *
   * @throws {Error} 形式が違う・どの鍵でも読めない・改ざんされている場合
   */
  open(sealed: string): { plaintext: string; oldKey: boolean } {
    const [version, iv, tag, body] = sealed.split(':');
    if (version !== VERSION || !iv || !tag || !body) throw new Error('暗号文の形式が違います');
    for (const [i, key] of [this.key, ...this.oldKeys].entries()) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
        decipher.setAuthTag(Buffer.from(tag, 'base64'));
        return { plaintext: Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8'), oldKey: i > 0 };
      } catch {
        // 次の鍵を試す
      }
    }
    throw new Error('暗号文を読めません（鍵が違うか、改ざんされています）');
  }
}

/** 開発用の固定の鍵。本番では使えない。 */
const DEV_SECRET = 'm2office-development-only-secret-key';

/**
 * 設定から SecretBox を作る。
 *
 * @throws {Error} 本番（`NODE_ENV=production`）で `M2OFFICE_SECRET_KEY` が無い場合。起動を止める
 * @returns 箱と、開発用の固定の鍵を使っているか（警告を出すため）
 */
export function secretBoxFromEnv(env: Record<string, string | undefined> = process.env): { box: SecretBox; devKey: boolean } {
  const secret = env['M2OFFICE_SECRET_KEY'];
  // 前の鍵（鍵の入れ替えの途中。読むときだけ使う。第16.11.3節 G-10）
  const old = (env['M2OFFICE_SECRET_KEY_OLD'] ?? '').split(',');
  if (secret) return { box: new SecretBox(secret, old), devKey: false };
  if (env['NODE_ENV'] === 'production') {
    throw new Error('M2OFFICE_SECRET_KEY が設定されていません。本番では秘密の値を暗号化する鍵が必要です（ADR-0007）');
  }
  return { box: new SecretBox(DEV_SECRET), devKey: true };
}
