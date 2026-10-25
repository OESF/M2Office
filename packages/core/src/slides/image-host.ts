/**
 * @file スライドの画像を、Google から読める使い捨ての URL で渡す（クラウドの形。仕様書 第9.4.2節「段 2」、Q-263）。
 *
 * Slides API は画像を Google から読める URL でしか受け取らない。Google は貼るときに 1 度だけ読み、プレゼンテーションの中に写しを持つ。
 * そこで、画像を 5 分だけ置き、推測できない鍵の URL（`<会社のアドレス>/v1/public/slide-images/<鍵>`）で渡し、貼り終えたらすぐ消す。
 * 鍵は 32 バイトの乱数で、置き場には SHA-256 だけを持つ。ローカルの形は Google から届かないため使わない（本人のドライブで一時的に共有する）。
 */

import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { createPool } from '../repository/pool.js';

/** 置いておく時間。 */
export const SLIDE_IMAGE_TTL_MS = 5 * 60_000;

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

/** 画像の使い捨ての置き場（PostgreSQL。移行 158）。 */
export class PostgresSlideImageHost {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 2, name: 'slide-images' });
  }

  private async tx<T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 画像を置き、使い捨ての URL を返す。`done` で消す（呼ばなくても 5 分で切れ、次に置くときに消える）。
   *
   * @param baseUrl 会社の画面のアドレス（`https://<会社>.<本番のドメイン>`）
   */
  async publish(tenantId: string, baseUrl: string, bytes: Uint8Array, mimeType: string): Promise<{ url: string; done(): Promise<void> }> {
    const mime = /^image\/(png|jpeg|gif)$/.test(mimeType) ? mimeType : 'image/png';
    const token = randomBytes(32).toString('base64url');
    const hash = hashOf(token);
    await this.tx(tenantId, async (c) => {
      await c.query('delete from slide_images where tenant_id = $1 and expires_at <= now()', [tenantId]);
      await c.query('insert into slide_images (token_hash, tenant_id, mime, bytes, expires_at) values ($1, $2, $3, $4, $5)',
        [hash, tenantId, mime, Buffer.from(bytes), new Date(Date.now() + SLIDE_IMAGE_TTL_MS).toISOString()]);
    });
    return {
      url: `${baseUrl.replace(/\/+$/, '')}/v1/public/slide-images/${token}`,
      done: async () => { await this.tx(tenantId, (c) => c.query('delete from slide_images where token_hash = $1', [hash])).catch(() => undefined); },
    };
  }

  /** 鍵から、切れていない画像を読む（公開の道。会社を問わない関数で読む）。無ければ `null`。 */
  async take(token: string): Promise<{ mime: string; bytes: Uint8Array } | null> {
    if (!/^[A-Za-z0-9_-]{30,60}$/.test(token)) return null;
    const r = await this.pool.query<{ mime: string; bytes: Buffer }>('select mime, bytes from m2o_slide_image($1)', [hashOf(token)]);
    const row = r.rows[0];
    return row ? { mime: row.mime, bytes: new Uint8Array(row.bytes) } : null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
