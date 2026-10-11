/**
 * @file 不正の兆しの見張り（仕様書 第16.8節、ADR-0091）の置き場。見つけた兆し・「これは大丈夫」の記録と、
 * 見張りが読むログイン中の端末と監査ログの数を受け持つ。
 *
 * 中身（開いた記録・業務の中身・場所）は持たない。兆しの型・重さ・対象の人・数だけを持つ。
 * PostgreSQL の置き場は、問い合わせごとに `app.tenant_id` を設定する（行単位の制限。移行 122）。
 */

import type pg from 'pg';
import { createPool } from '../repository/pool.js';

/** 開いた数を数える記録の種類（段 2。第16.8.4節）。 */
export type SecurityViewKind = 'contact' | 'inquiry' | 'member' | 'contract' | 'hr_employee';

/** 兆しの型。 */
export type SecuritySignalType =
  | 'export' | 'export_burst' | 'bulk_mail' | 'mass_view' | 'login_disabled' | 'session_disabled' | 'login_burst' | 'login_flood'
  | 'admin_added' | 'permission_burst' | 'new_device' | 'auto_signout';

/** 見つけた兆し。 */
export interface SecuritySignal {
  id: string;
  type: SecuritySignalType;
  severity: 'high' | 'medium';
  /** 対象の人（分からなければ `null`）。 */
  userId: string | null;
  /** 二度知らせないための鍵。 */
  key: string;
  /** 数・時間の帯など（中身は入れない）。 */
  detail: Record<string, unknown>;
  createdAt: string;
}

/** 見張りが読むログイン中の端末（中身・場所は持たない）。 */
export interface LiveSession {
  id: string;
  userId: string;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
}

/** 不正の兆しの見張りの置き場。 */
export interface SecurityStore {
  /** 兆しを残す。同じ型と鍵がすでにあれば残さず `false`。 */
  addSignal(tenantId: string, s: SecuritySignal): Promise<boolean>;
  /** この時刻より後の兆し（新しい順）。 */
  recentSignals(tenantId: string, since: string, limit?: number): Promise<SecuritySignal[]>;
  /** 「これは大丈夫」と言われた型を、この時刻まで知らせない。 */
  suppress(tenantId: string, userId: string, type: SecuritySignalType, until: string, by: string): Promise<void>;
  /** 同じ人・同じ型を知らせない間か。 */
  isSuppressed(tenantId: string, userId: string, type: SecuritySignalType, now: string): Promise<boolean>;
  /** 利用中の端末（止めていない・切れていない）。 */
  liveSessions(tenantId: string, now: string): Promise<LiveSession[]>;
  /** 監査ログの、この操作・この対象の、この時刻より後の数。 */
  countAudit(tenantId: string, action: string, targetId: string, since: string): Promise<number>;
  /** 見回った時刻を残す（ダッシュボードの「見張り中」。移行 123）。 */
  markScan(tenantId: string, at: string): Promise<void>;
  /** 最後に見回った時刻（まだなら `null`）。 */
  lastScan(tenantId: string): Promise<string | null>;
  /** 開いた数を 1 つ数える（人と 1 時間ごとの件数だけ。どの記録かは持たない）。 */
  countView(tenantId: string, userId: string, kind: SecurityViewKind, hour: string): Promise<void>;
  /** この時刻から後の、人と 1 時間ごとの開いた数（種類はまとめる）。 */
  viewCounts(tenantId: string, since: string): Promise<{ userId: string; hour: string; n: number }[]>;
  /** この時刻より前の開いた数を消す（7 日で消す）。 */
  pruneViews(tenantId: string, before: string): Promise<void>;
}

interface SignalRow { id: string; type: SecuritySignalType; severity: 'high' | 'medium'; user_id: string | null; key: string; detail: Record<string, unknown> | null; created_at: unknown }
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const toSignal = (r: SignalRow): SecuritySignal => ({
  id: r.id, type: r.type, severity: r.severity, userId: r.user_id, key: r.key, detail: r.detail ?? {}, createdAt: iso(r.created_at),
});

/** PostgreSQL の見張りの置き場。 */
export class PostgresSecurityStore implements SecurityStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 2, name: 'security' });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async q<T extends pg.QueryResultRow>(tenantId: string, text: string, params: unknown[] = []): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const { rows } = await client.query<T>(text, params as never[]);
      await client.query('commit');
      return rows;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async addSignal(tenantId: string, s: SecuritySignal): Promise<boolean> {
    const rows = await this.q(tenantId,
      `insert into security_signals (id, tenant_id, type, severity, user_id, key, detail, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (tenant_id, type, key) do nothing returning id`,
      [s.id, tenantId, s.type, s.severity, s.userId, s.key, JSON.stringify(s.detail), s.createdAt]);
    return rows.length === 1;
  }

  async recentSignals(tenantId: string, since: string, limit = 50): Promise<SecuritySignal[]> {
    return (await this.q<SignalRow>(tenantId,
      'select * from security_signals where tenant_id = $1 and created_at > $2 order by created_at desc limit $3', [tenantId, since, limit])).map(toSignal);
  }

  async suppress(tenantId: string, userId: string, type: SecuritySignalType, until: string, by: string): Promise<void> {
    await this.q(tenantId,
      `insert into security_suppressions (tenant_id, user_id, type, until, created_by) values ($1,$2,$3,$4,$5)
       on conflict (tenant_id, user_id, type) do update set until = excluded.until, created_by = excluded.created_by, created_at = now()`,
      [tenantId, userId, type, until, by]);
  }

  async isSuppressed(tenantId: string, userId: string, type: SecuritySignalType, now: string): Promise<boolean> {
    return (await this.q(tenantId, 'select 1 from security_suppressions where tenant_id = $1 and user_id = $2 and type = $3 and until > $4',
      [tenantId, userId, type, now])).length === 1;
  }

  async liveSessions(tenantId: string, now: string): Promise<LiveSession[]> {
    const rows = await this.q<{ id: string; user_id: string; user_agent: string | null; created_at: unknown; last_seen_at: unknown }>(tenantId,
      `select id, user_id, user_agent, created_at, last_seen_at from sessions
        where tenant_id = $1 and revoked_at is null and expires_at > $2 order by user_id, last_seen_at desc`, [tenantId, now]);
    return rows.map((r) => ({ id: r.id, userId: r.user_id, userAgent: r.user_agent, createdAt: iso(r.created_at), lastSeenAt: iso(r.last_seen_at) }));
  }

  async countAudit(tenantId: string, action: string, targetId: string, since: string): Promise<number> {
    const [r] = await this.q<{ n: number }>(tenantId,
      'select count(*)::int as n from audit_events where tenant_id = $1 and action = $2 and target_id = $3 and occurred_at > $4', [tenantId, action, targetId, since]);
    return r?.n ?? 0;
  }

  async markScan(tenantId: string, at: string): Promise<void> {
    await this.q(tenantId,
      `insert into security_watch_state (tenant_id, last_scan_at) values ($1, $2)
       on conflict (tenant_id) do update set last_scan_at = excluded.last_scan_at`, [tenantId, at]);
  }

  async lastScan(tenantId: string): Promise<string | null> {
    const [r] = await this.q<{ last_scan_at: unknown }>(tenantId, 'select last_scan_at from security_watch_state where tenant_id = $1', [tenantId]);
    return r ? iso(r.last_scan_at) : null;
  }

  async countView(tenantId: string, userId: string, kind: SecurityViewKind, hour: string): Promise<void> {
    await this.q(tenantId,
      `insert into security_view_counts (tenant_id, user_id, hour, kind, n) values ($1,$2,$3,$4,1)
       on conflict (tenant_id, user_id, hour, kind) do update set n = security_view_counts.n + 1`, [tenantId, userId, hour, kind]);
  }

  async viewCounts(tenantId: string, since: string): Promise<{ userId: string; hour: string; n: number }[]> {
    const rows = await this.q<{ user_id: string; hour: unknown; n: number }>(tenantId,
      'select user_id, hour, sum(n)::int as n from security_view_counts where tenant_id = $1 and hour >= $2 group by user_id, hour', [tenantId, since]);
    return rows.map((r) => ({ userId: r.user_id, hour: iso(r.hour), n: r.n }));
  }

  async pruneViews(tenantId: string, before: string): Promise<void> {
    await this.q(tenantId, 'delete from security_view_counts where tenant_id = $1 and hour < $2', [tenantId, before]);
  }
}

/** メモリの見張りの置き場（試験用）。端末と監査ログの数は、渡したものを読む。 */
export class MemorySecurityStore implements SecurityStore {
  readonly signals: (SecuritySignal & { tenantId: string })[] = [];
  readonly suppressions = new Map<string, string>();
  sessions: (LiveSession & { tenantId: string })[] = [];
  audits: { tenantId: string; action: string; targetId: string; occurredAt: string }[] = [];

  async addSignal(tenantId: string, s: SecuritySignal): Promise<boolean> {
    if (this.signals.some((x) => x.tenantId === tenantId && x.type === s.type && x.key === s.key)) return false;
    this.signals.push({ ...s, tenantId });
    return true;
  }

  async recentSignals(tenantId: string, since: string, limit = 50): Promise<SecuritySignal[]> {
    return this.signals.filter((s) => s.tenantId === tenantId && s.createdAt > since).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit).map(({ tenantId: _t, ...s }) => s);
  }

  async suppress(tenantId: string, userId: string, type: SecuritySignalType, until: string): Promise<void> {
    this.suppressions.set([tenantId, userId, type].join('\u0000'), until);
  }

  async isSuppressed(tenantId: string, userId: string, type: SecuritySignalType, now: string): Promise<boolean> {
    const until = this.suppressions.get([tenantId, userId, type].join('\u0000'));
    return !!until && until > now;
  }

  async liveSessions(tenantId: string): Promise<LiveSession[]> {
    return this.sessions.filter((s) => s.tenantId === tenantId).map(({ tenantId: _t, ...s }) => s);
  }

  async countAudit(tenantId: string, action: string, targetId: string, since: string): Promise<number> {
    return this.audits.filter((a) => a.tenantId === tenantId && a.action === action && a.targetId === targetId && a.occurredAt > since).length;
  }

  readonly scans = new Map<string, string>();

  async markScan(tenantId: string, at: string): Promise<void> {
    this.scans.set(tenantId, at);
  }

  async lastScan(tenantId: string): Promise<string | null> {
    return this.scans.get(tenantId) ?? null;
  }

  readonly views = new Map<string, number>();

  async countView(tenantId: string, userId: string, kind: SecurityViewKind, hour: string): Promise<void> {
    const k = [tenantId, userId, hour, kind].join('\u0000');
    this.views.set(k, (this.views.get(k) ?? 0) + 1);
  }

  async viewCounts(tenantId: string, since: string): Promise<{ userId: string; hour: string; n: number }[]> {
    const out = new Map<string, { userId: string; hour: string; n: number }>();
    for (const [k, n] of this.views) {
      const [t, userId, hour] = k.split('\u0000') as [string, string, string];
      if (t !== tenantId || hour < since) continue;
      const key = `${userId}\u0000${hour}`;
      out.set(key, { userId, hour, n: (out.get(key)?.n ?? 0) + n });
    }
    return [...out.values()];
  }

  async pruneViews(tenantId: string, before: string): Promise<void> {
    for (const k of [...this.views.keys()]) {
      const [t, , hour] = k.split('\u0000') as [string, string, string];
      if (t === tenantId && hour < before) this.views.delete(k);
    }
  }
}
