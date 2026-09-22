/**
 * @file 秘密の値（Gemini の鍵・OAuth のクライアント シークレット・リフレッシュ トークン）の暗号化と復号。
 *
 * AES-256-GCM で暗号化する。暗号の鍵はサーバーの設定 `M2OFFICE_SECRET_KEY` に置き、データベースには置かない。
 * データベースが漏れても、値を読めないようにするため。
 *
 * @see 仕様書 第14.3.3節「保存」
 * @see ADR-0007 接続の設定
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** 暗号文の形式の版。形式を変えるときに古いものを読み分ける。 */
const VERSION = 'v1';

/** 秘密の値を暗号化・復号する。 */
export class SecretBox {
  private readonly key: Buffer;

  /**
   * @param secret 暗号の鍵。32 バイトの Base64 ならそのまま、それ以外の文字列なら SHA-256 で 32 バイトにする
   */
  constructor(secret: string) {
    const raw = Buffer.from(secret, 'base64');
    this.key = raw.length === 32 && /^[A-Za-z0-9+/=]+$/.test(secret) ? raw : createHash('sha256').update(secret).digest();
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
    const [version, iv, tag, body] = sealed.split(':');
    if (version !== VERSION || !iv || !tag || !body) throw new Error('暗号文の形式が違います');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
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
  if (secret) return { box: new SecretBox(secret), devKey: false };
  if (env['NODE_ENV'] === 'production') {
    throw new Error('M2OFFICE_SECRET_KEY が設定されていません。本番では秘密の値を暗号化する鍵が必要です（ADR-0007）');
  }
  return { box: new SecretBox(DEV_SECRET), devKey: true };
}
