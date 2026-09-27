/**
 * @file 認証の要る会社の接続で、呼ぶときに付ける認可を用意する（仕様書 第12.11.6.4節・第12.11.6.5節）。
 *
 * `oauth` は**依頼した本人の認可**、`api_key` は会社の鍵を返す。ほかの人の認可で代わりに呼ばない（不変則 I-9）。
 * 期限の近い認可は更新し、相手に断られたら 1 回だけ更新して呼び直す。更新できなければ認可を消し、本人に知らせる。
 * 認可の値はここでだけ復号し、記録にも推論にも画面にも出さない。
 */

import { randomUUID } from 'node:crypto';
import type { Repository, UserConnection } from '../repository/types.js';
import type { SecretBox } from '../secrets/box.js';
import type { ConnectionAuthProvider, ConnectorDeclaration } from '../extensions/connectors.js';
import { ConnectionOAuthError, refreshConnectionToken } from './oauth.js';

/** 期限のどれだけ前に更新するか（ミリ秒）。 */
const REFRESH_MARGIN_MS = 60_000;

/**
 * 利用者に伝える「接続が要ります」の文（仕様書 第12.11.6.3節「求められたときに接続する」）。
 *
 * @remarks 業務の失敗の理由と秘書の答えにそのまま出る。「鍵」「トークン」と言わない（原則 u1）
 */
export function needsConnectionMessage(name: string): string {
  return `「${name}」との接続が要ります。個人設定の「サービスとの接続」から接続してください`;
}

/** 認可が切れたときの文（第12.11.6.5節）。 */
export function lostConnectionMessage(name: string): string {
  return `「${name}」との接続が切れました。個人設定の「サービスとの接続」から接続し直してください`;
}

type Result = { ok: true; headers: Record<string, string> } | { ok: false; error: string };

export interface ConnectionCredentialsDeps {
  repo: Repository;
  box: SecretBox;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * 会社の接続の認可を用意する（{@link ConnectionAuthProvider} の実装）。ワーカーと API（接続の確認・道具の取り直し）が使う。
 */
export class ConnectionCredentials implements ConnectionAuthProvider {
  constructor(private readonly deps: ConnectionCredentialsDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async headersFor(tenantId: string, userId: string, c: ConnectorDeclaration): Promise<Result> {
    if (c.auth.type === 'api_key') return this.apiKey(tenantId, c);
    if (c.auth.type !== 'oauth') return { ok: true, headers: {} };
    const client = await this.client(tenantId, c);
    if (!client.ok) return client;
    const uc = await this.deps.repo.getUserConnection(tenantId, userId, c.id);
    if (!uc) return { ok: false, error: needsConnectionMessage(c.name) };
    // 会社がクライアント ID を替えた。前のクライアントの認可は使えない（第12.11.6.2節）
    if (uc.clientId !== client.clientId) return this.lose(uc, c, '会社の接続の設定が替わった');
    if (uc.expiresAt && Date.parse(uc.expiresAt) - REFRESH_MARGIN_MS < this.now().getTime()) {
      if (!uc.refreshTokenEnc) return this.lose(uc, c, '認可の期限が切れ、更新の仕組みが無い');
      return this.refresh(uc, c, client);
    }
    return { ok: true, headers: bearer(this.deps.box.decrypt(uc.accessTokenEnc)) };
  }

  async onRejected(tenantId: string, userId: string, c: ConnectorDeclaration): Promise<Result> {
    if (c.auth.type === 'api_key') return { ok: false, error: `「${c.name}」が会社の鍵を受け付けませんでした。管理者ページの「接続」で鍵を確かめてください` };
    if (c.auth.type !== 'oauth') return { ok: false, error: `「${c.name}」に断られました` };
    const client = await this.client(tenantId, c);
    if (!client.ok) return client;
    const uc = await this.deps.repo.getUserConnection(tenantId, userId, c.id);
    if (!uc) return { ok: false, error: needsConnectionMessage(c.name) };
    if (!uc.refreshTokenEnc) return this.lose(uc, c, '相手のサービスに認可を断られた');
    return this.refresh(uc, c, client);
  }

  /** 会社の鍵（`api_key`）を見出しにする。 */
  private async apiKey(tenantId: string, c: ConnectorDeclaration): Promise<Result> {
    const s = await this.deps.repo.getConnectionSecret(tenantId, c.id);
    if (!s?.apiKeyEnc) return { ok: false, error: `「${c.name}」の会社の鍵が登録されていません（管理者ページの「接続」で登録します）` };
    const key = this.deps.box.decrypt(s.apiKeyEnc);
    const header = c.auth.header ?? 'Authorization';
    return { ok: true, headers: { [header]: header.toLowerCase() === 'authorization' ? `Bearer ${key}` : key } };
  }

  /** 会社が登録したアプリ（クライアント ID とシークレット）。 */
  private async client(tenantId: string, c: ConnectorDeclaration): Promise<{ ok: true; clientId: string; clientSecret: string } | { ok: false; error: string }> {
    const s = await this.deps.repo.getConnectionSecret(tenantId, c.id);
    if (!s?.clientId || !s.clientSecretEnc) return { ok: false, error: `「${c.name}」の接続の設定が済んでいません（管理者ページの「接続」で設定します）` };
    return { ok: true, clientId: s.clientId, clientSecret: this.deps.box.decrypt(s.clientSecretEnc) };
  }

  /** 更新用の認可で新しい認可を受け取り、保存する。できなければ認可を消す。 */
  private async refresh(uc: UserConnection, c: ConnectorDeclaration, client: { clientId: string; clientSecret: string }): Promise<Result> {
    if (!c.auth.tokenUrl || !uc.refreshTokenEnc) return this.lose(uc, c, '更新の口が分からない');
    try {
      const t = await refreshConnectionToken({
        tokenUrl: c.auth.tokenUrl, clientId: client.clientId, clientSecret: client.clientSecret,
        refreshToken: this.deps.box.decrypt(uc.refreshTokenEnc),
      }, this.deps.fetchImpl, this.now());
      await this.deps.repo.saveUserConnection({
        ...uc,
        accessTokenEnc: this.deps.box.encrypt(t.accessToken),
        refreshTokenEnc: t.refreshToken ? this.deps.box.encrypt(t.refreshToken) : uc.refreshTokenEnc,
        expiresAt: t.expiresAt,
        scopes: t.scopes.length > 0 ? t.scopes : uc.scopes,
        updatedAt: this.now().toISOString(),
      });
      return { ok: true, headers: bearer(t.accessToken) };
    } catch (err) {
      return this.lose(uc, c, err instanceof ConnectionOAuthError ? err.message : '更新に失敗した');
    }
  }

  /**
   * 認可が切れた。保存した認可を消し、本人に一度知らせる（第12.11.6.5節）。
   *
   * @remarks 理由（`why`）は監査ログにだけ残す。本人には接続し直しの案内を出す
   */
  private async lose(uc: UserConnection, c: ConnectorDeclaration, why: string): Promise<Result> {
    const at = this.now().toISOString();
    const removed = await this.deps.repo.deleteUserConnection(uc.tenantId, uc.userId, c.id);
    if (removed) {
      await this.deps.repo.appendAudit({
        id: randomUUID(), tenantId: uc.tenantId, actorType: 'system', actorId: 'connection', action: 'connection.oauth.lost',
        targetType: 'connection', targetId: c.id, detail: { userId: uc.userId, why }, occurredAt: at,
      });
      await this.deps.repo.createNotification({
        id: randomUUID(), tenantId: uc.tenantId, userId: uc.userId, kind: 'failure',
        title: `${c.name}との接続が切れました`, body: lostConnectionMessage(c.name),
        runId: null, readAt: null, createdAt: at,
      });
    }
    return { ok: false, error: lostConnectionMessage(c.name) };
  }
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
