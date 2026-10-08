/**
 * @file マスター管理画面の、アプリのロールの側の口（仕様書 第23.8.15節・第23.8.14節）。
 *
 * ワーカーが動いていることの知らせ（`worker_beats`）と毎晩の数の記録（`m2o_ops_record_daily`）、
 * 顧客の API が運営主体の設定を読むこと（`m2o_operator_profile`）。どれもアプリのロールで、決めた口だけを使う。
 */

import type pg from 'pg';
import type { OperatorProfile } from './store.js';

/** 運営主体の設定を覚えておく長さ（5 分）。 */
const PROFILE_TTL_MS = 5 * 60_000;

/**
 * アプリのロールの側の口。
 *
 * @remarks 運営の表を直接は触らない。所有者の権限で動く決めた関数と、会社を持たない `worker_beats` だけ
 */
export class OpsAppSide {
  private profile: { at: number; value: OperatorProfile | null } | null = null;

  constructor(private readonly pool: pg.Pool) {}

  /** ワーカーが動いていることを書く。1 日より古い知らせは消す。 */
  async beat(id: string, version: string | null): Promise<void> {
    await this.pool.query(
      'insert into worker_beats (id, at, version) values ($1, now(), $2) on conflict (id) do update set at = now(), version = excluded.version',
      [id, version],
    );
    await this.pool.query(`delete from worker_beats where at < now() - interval '1 day'`);
  }

  /**
   * その日（日本時間）の会社ごとの数を運営の表に書く。同じ日は書き替える。
   *
   * @returns 書いた会社の数
   */
  async recordDaily(day: string): Promise<number> {
    const { rows } = await this.pool.query('select m2o_ops_record_daily($1::date) as n', [day]);
    return Number(rows[0]?.n ?? 0);
  }

  /** 運営主体の設定（法人名が入っていなければ `null`）。5 分覚えておく。 */
  async operatorProfile(now = Date.now()): Promise<OperatorProfile | null> {
    if (this.profile && now - this.profile.at < PROFILE_TTL_MS) return this.profile.value;
    const { rows } = await this.pool.query('select * from m2o_operator_profile()');
    const r = rows[0];
    const value = r && r.name_ja ? { nameJa: r.name_ja, nameEn: r.name_en, address: r.address, web: r.web, contact: r.contact } : null;
    this.profile = { at: now, value };
    return value;
  }
}
