/**
 * @file システムログをデータベースにも書く（仕様書 第16.10.1節、ADR-0098）。
 *
 * ロガーの記録（`info` から上・伏せ字の後）を受け取り、2 秒ごとにまとめて表 `system_logs` に書く。1 件ずつ書いて要求を遅らせない。
 * データベースに書けないときは捨て、捨てた数を標準エラーに書く（ログのためにアプリを止めない。ロガーを通すと同じ口に戻るので通さない）。
 */

import type { LogFields, LogLevel } from './logger.js';

/** 問い合わせを 1 つ送る口（`pg.Pool` の `query` と同じ形）。 */
export type LogQuery = (sql: string, params: unknown[]) => Promise<unknown>;

/** 1 回に書く件数の上限。溜まりすぎたら古いものから捨てる上限はその 10 倍。 */
const BATCH = 1000;
/** 書く間隔（ミリ秒）。 */
const FLUSH_MS = 2000;

/** 記録の中で、列に分けて持つ項目。残りは `fields`（JSON）に入れる。 */
const COLUMNS = ['time', 'level', 'service', 'msg', 'tenantId', 'userId', 'requestId', 'runId'] as const;

/** データベースに書く 1 行（`jsonb_to_recordset` の形）。 */
interface Row {
  at: string; level: string; service: string; msg: string;
  tenant_id: string | null; user_id: string | null; request_id: string | null; run_id: string | null; fields: LogFields;
}

/** 記録を 1 行にする。 */
export function logRow(record: LogFields): Row {
  const fields: LogFields = {};
  for (const [k, v] of Object.entries(record)) if (!(COLUMNS as readonly string[]).includes(k)) fields[k] = v;
  const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 200) : null);
  return {
    at: String(record['time']), level: String(record['level']), service: String(record['service']), msg: String(record['msg']).slice(0, 500),
    tenant_id: str(record['tenantId']), user_id: str(record['userId']), request_id: str(record['requestId']), run_id: str(record['runId']), fields,
  };
}

/**
 * システムログをデータベースに書く口。`attachLogSink(sink.accept)` でロガーにつなぐ。
 *
 * @remarks テナント境界: 会社の ID は記録に入っているものをそのまま書く（読むのは決まった関数だけ。第16.10.1節）
 */
export class SystemLogSink {
  private buffer: Row[] = [];
  private dropped = 0;
  private lastDropReport = 0;
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;

  constructor(private readonly query: LogQuery, private readonly now: () => number = Date.now) {}

  /** ロガーから受け取る（速く返す）。 */
  readonly accept = (record: LogFields, _level: LogLevel): void => {
    if (this.buffer.length >= BATCH * 10) { this.buffer.shift(); this.dropped++; }
    this.buffer.push(logRow(record));
  };

  /** 2 秒ごとに書き始める。 */
  start(): this {
    if (!this.timer) {
      this.timer = setInterval(() => { void this.flush(); }, FLUSH_MS);
      this.timer.unref?.();
    }
    return this;
  }

  /** 止める（残りを書く）。 */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  /** 溜まった分を書く。 */
  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    try {
      while (this.buffer.length) {
        const rows = this.buffer.splice(0, BATCH);
        try {
          await this.query(
            `insert into system_logs (at, level, service, msg, tenant_id, user_id, request_id, run_id, fields)
             select at, level, service, msg, tenant_id, user_id, request_id, run_id, coalesce(fields, '{}'::jsonb)
               from jsonb_to_recordset($1::jsonb) as x(at timestamptz, level text, service text, msg text, tenant_id text, user_id text, request_id text, run_id text, fields jsonb)`,
            [JSON.stringify(rows)],
          );
        } catch (err) {
          this.dropped += rows.length;
          this.report(err);
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /** 捨てた数を、1 分に 1 回だけ標準エラーに書く。 */
  private report(err: unknown): void {
    if (this.now() - this.lastDropReport < 60_000) return;
    this.lastDropReport = this.now();
    process.stderr.write(`${JSON.stringify({ time: new Date(this.now()).toISOString(), level: 'warn', service: 'log-sink', msg: 'システムログをデータベースに書けませんでした', dropped: this.dropped, err: err instanceof Error ? err.message : String(err) })}\n`);
  }
}
