/**
 * @file 代理アクセス（仕様書 第23.6.1節）。運営のサポートが、会社の管理者の許しを得て、期限まで会社の画面を閲覧だけで見る。
 *
 * 顧客向けの API の側で使う。申請と許可（`proxy_grants`）と閲覧のログイン状態（`proxy_sessions`）は会社ごとの行レベルセキュリティで、
 * アプリのロールが会社を決めてから触る。閲覧のログイン状態の要求は、範囲ごとに決めた見るだけの道（{@link proxyAllowed}）に限る。
 */

import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';

/** 代理アクセスの範囲。`admin` は管理者ページ、`runs` は加えて許した管理者が依頼した業務の結果。 */
export type ProxyScope = 'admin' | 'runs';

/** 許すときに選べる期限（時間）。既定は 1 日。 */
export const PROXY_HOURS = [1, 4, 24, 72] as const;
export const PROXY_DEFAULT_HOURS = 24;

/** 管理者ページのうち、どちらの範囲でも見せない道（知識・監査ログの書き出し・実行の中身の段・サポートの閲覧そのもの）。 */
const ADMIN_DENY = [/^\/v1\/admin\/knowledge(\/|$)/, /^\/v1\/admin\/audit-events\/export(\/|$)/, /^\/v1\/admin\/support(\/|$)/];

/**
 * 閲覧のログイン状態で、その要求を通すか（見るだけの決めた道だけ）。
 *
 * @param scope 許された範囲
 * @param method HTTP メソッド
 * @param path 要求の道（`/v1/...`）
 * @remarks 書き込みはすべて断る（ログアウトだけは通す）。秘書・会話・個人の記憶・各業務の台帳・ファイルの取り出しは、道を許さないことで断る
 */
export function proxyAllowed(scope: ProxyScope, method: string, path: string): boolean {
  if (method === 'POST' && path === '/v1/auth/logout') return true;
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (path === '/v1/me' || path === '/v1/onboarding/checklist' || path.startsWith('/v1/help/') || path === '/v1/help') return true;
  if (path.startsWith('/v1/admin/') && !ADMIN_DENY.some((d) => d.test(path))) return true;
  // 業務の結果: 実行の中身（許した管理者が依頼したものだけ。実行の道の側で確かめる）
  if (scope === 'runs' && /^\/v1\/runs\/[^/]+$/.test(path)) return true;
  return false;
}

/** 代理アクセスの申請（会社の管理者が見る形）。 */
export interface ProxyGrant {
  id: string;
  operatorId: string;
  operatorLabel: string;
  scope: ProxyScope;
  reason: string;
  /** いまの状態（許した期限を過ぎていれば `expired`）。`revoked` は会社の管理者が切った、`ended` は運営者が終えた。 */
  state: 'requested' | 'approved' | 'denied' | 'revoked' | 'ended' | 'withdrawn' | 'expired';
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  hours: number | null;
  expiresAt: string | null;
  endedAt: string | null;
  /** 閲覧した回数（会社の監査ログの `proxy.view`）。 */
  views: number;
}

/** 閲覧のログイン状態（Cookie の値は持たず、SHA-256 を持つ）。 */
export interface ProxySessionInfo {
  sessionId: string;
  csrfToken: string;
  grant: ProxyGrant;
}

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

function toGrant(r: Record<string, unknown>): ProxyGrant {
  const expired = r['state'] === 'approved' && r['expires_at'] && new Date(r['expires_at'] as string).getTime() <= Date.now();
  return {
    id: String(r['id']), operatorId: String(r['operator_id']), operatorLabel: String(r['operator_label']), scope: r['scope'] as ProxyScope,
    reason: String(r['reason']), state: (expired ? 'expired' : r['state']) as ProxyGrant['state'], requestedAt: iso(r['requested_at'])!,
    decidedBy: (r['decided_by'] as string | null) ?? null, decidedAt: iso(r['decided_at']), hours: (r['hours'] as number | null) ?? null,
    expiresAt: iso(r['expires_at']), endedAt: iso(r['ended_at']), views: Number(r['views'] ?? 0),
  };
}

const GRANT_SELECT = `select g.*, (select count(*) from audit_events e where e.tenant_id = g.tenant_id and e.action = 'proxy.view' and e.detail->>'grant' = g.id) as views
  from proxy_grants g`;

/**
 * 代理アクセスの、顧客向けの API の側の口（アプリのロール。会社ごとの行レベルセキュリティ）。
 *
 * @remarks 会社を決めてから触る（`app.tenant_id`）。ほかの会社の申請とログイン状態は見えない
 */
export class ProxyAccessStore {
  constructor(private readonly pool: pg.Pool) {}

  private async q<T extends pg.QueryResultRow>(tenantId: string, text: string, params: unknown[] = []): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const res = await client.query<T>(text, params as never[]);
      await client.query('commit');
      return res.rows;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** 会社の申請の一覧（新しい順）。 */
  async list(tenantId: string): Promise<ProxyGrant[]> {
    return (await this.q(tenantId, `${GRANT_SELECT} where g.tenant_id = $1 order by g.requested_at desc limit 100`, [tenantId])).map(toGrant);
  }

  /**
   * 許すか断る（会社の管理者）。許すときは期限を選ぶ。
   *
   * @returns 扱った申請（許すか待ちでなければ `null`）
   */
  async decide(tenantId: string, id: string, approve: boolean, hours: number, userId: string): Promise<ProxyGrant | null> {
    const h = (PROXY_HOURS as readonly number[]).includes(hours) ? hours : PROXY_DEFAULT_HOURS;
    const rows = await this.q(tenantId,
      `update proxy_grants set state = $3, decided_by = $4, decided_at = now(),
              hours = case when $3 = 'approved' then $5::int else null end,
              expires_at = case when $3 = 'approved' then now() + make_interval(hours => $5::int) else null end,
              ended_at = case when $3 = 'denied' then now() else null end,
              notified_at = case when $3 = 'denied' then now() else null end
        where tenant_id = $1 and id = $2 and state = 'requested' returning *`,
      [tenantId, id, approve ? 'approved' : 'denied', userId, h]);
    return rows[0] ? toGrant(rows[0]) : null;
  }

  /** 許した閲覧を切る（会社の管理者。いつでも）。閲覧のログイン状態も消す。 */
  async revoke(tenantId: string, id: string, userId: string): Promise<ProxyGrant | null> {
    const rows = await this.q(tenantId,
      `update proxy_grants set state = 'revoked', ended_at = now(), ticket_hash = null, decided_by = coalesce(decided_by, $3)
        where tenant_id = $1 and id = $2 and state = 'approved' and expires_at > now() returning *`,
      [tenantId, id, userId]);
    await this.q(tenantId, 'delete from proxy_sessions where tenant_id = $1 and grant_id = $2', [tenantId, id]);
    return rows[0] ? toGrant(rows[0]) : null;
  }

  /**
   * 運営の画面が出した 1 回だけの引換券を、閲覧のログイン状態に換える。
   *
   * @returns Cookie に入れる値と CSRF の値と申請（券が違う・切れた・許されていなければ `null`）
   */
  async exchange(tenantId: string, ticket: string): Promise<{ token: string; csrfToken: string; grant: ProxyGrant } | null> {
    const rows = await this.q(tenantId,
      `update proxy_grants set ticket_hash = null, ticket_expires_at = null
        where tenant_id = $1 and ticket_hash = $2 and ticket_expires_at > now() and state = 'approved' and expires_at > now() returning *`,
      [tenantId, sha(ticket)]);
    if (!rows[0]) return null;
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(24).toString('base64url');
    await this.q(tenantId, 'insert into proxy_sessions (id, tenant_id, grant_id, csrf_token) values ($1,$2,$3,$4)', [sha(token), tenantId, rows[0]['id'], csrfToken]);
    return { token, csrfToken, grant: toGrant(rows[0]) };
  }

  /** Cookie の値から、有効な閲覧のログイン状態を探す（許した期限を過ぎていれば `null`）。 */
  async findSession(tenantId: string, token: string): Promise<ProxySessionInfo | null> {
    const rows = await this.q(tenantId,
      `select s.id as session_id, s.csrf_token, g.*, 0 as views from proxy_sessions s join proxy_grants g on g.id = s.grant_id
        where s.tenant_id = $1 and s.id = $2 and g.state = 'approved' and g.expires_at > now()`,
      [tenantId, sha(token)]);
    const r = rows[0];
    return r ? { sessionId: String(r['session_id']), csrfToken: String(r['csrf_token']), grant: toGrant(r) } : null;
  }

  /** 閲覧のログイン状態を消す（閲覧を終える）。 */
  async endSession(tenantId: string, sessionId: string): Promise<void> {
    await this.q(tenantId, 'delete from proxy_sessions where tenant_id = $1 and id = $2', [tenantId, sessionId]);
  }
}
