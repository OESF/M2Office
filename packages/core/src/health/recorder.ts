/**
 * @file 接続先の健全性の記録（仕様書 第6.7.6節）。呼び出しごとの成否と時間を受け取り、1 分単位に足し込んで置き場へ流す。
 *
 * 記録するのは**成否と時間と失敗の種類だけ**。依頼や応答の中身と、誰の呼び出しかは受け取らない。
 * 受け口はプロセスに 1 つ置き（{@link installHealthSink}）、呼ぶ側（推論・Google・会社の接続）は {@link recordHealth} を呼ぶだけにする。
 * 受け口が無ければ何もしない（自動テストと、記録を持たない道具）。
 */

import type { HealthBucket, HealthStore } from './store.js';

/** 呼び出し 1 回の結果を受け取る口。 */
export interface HealthSink {
  record(tenantId: string, target: string, ok: boolean, ms: number, errorKind?: string): void;
}

let sink: HealthSink | null = null;

/**
 * このプロセスの受け口を置く（外すときは `null`）。
 *
 * @remarks API とワーカーの起動のときに 1 度だけ呼ぶ
 */
export function installHealthSink(next: HealthSink | null): void {
  sink = next;
}

/**
 * 呼び出し 1 回の結果を記録する。
 *
 * @param target 接続先（`ai`・`google:gmail`・`mcp:<接続の ID>`）
 * @param errorKind 失敗の種類（`busy`・`unreachable`・`timeout`・`server`・`setup`・`auth`・`not-found`・`error`）。文は渡さない
 * @remarks 記録に失敗しても呼び出し側には伝えない（本来の仕事を止めない）
 */
export function recordHealth(tenantId: string, target: string, ok: boolean, ms: number, errorKind?: string): void {
  try {
    sink?.record(tenantId, target, ok, Math.max(0, Math.round(ms)), errorKind);
  } catch {
    // 記録できなくても本来の仕事は続ける
  }
}

/**
 * 手元に貯めて、まとめて置き場へ流す受け口。
 *
 * @remarks 呼び出しのたびにデータベースへ書かない。{@link flush} を一定の間隔で呼ぶ（API とワーカーで 30 秒ごと）
 */
export class BufferedHealthSink implements HealthSink {
  private buffer = new Map<string, HealthBucket>();

  constructor(private readonly store: HealthStore, private readonly now: () => number = () => Date.now()) {}

  record(tenantId: string, target: string, ok: boolean, ms: number, errorKind?: string): void {
    const minute = new Date(Math.floor(this.now() / 60_000) * 60_000).toISOString();
    const key = `${tenantId}\u0000${target}\u0000${minute}`;
    const b = this.buffer.get(key) ?? { tenantId, target, minute, ok: 0, fail: 0, totalMs: 0, lastError: null };
    if (ok) b.ok += 1;
    else { b.fail += 1; b.lastError = errorKind ?? 'error'; }
    b.totalMs += ms;
    this.buffer.set(key, b);
  }

  /**
   * 貯めた分を置き場へ流す。流せなかった分は捨てる（健全性の表示のための記録で、取りこぼしても害が小さい）。
   *
   * @returns 流した件数
   */
  async flush(): Promise<number> {
    const items = [...this.buffer.values()];
    this.buffer = new Map();
    let n = 0;
    for (const b of items) {
      try {
        await this.store.add(b);
        n += 1;
      } catch {
        // 次の回へは持ち越さない
      }
    }
    return n;
  }
}
