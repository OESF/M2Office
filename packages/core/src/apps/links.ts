/**
 * @file 外部のアプリの機能「アカウントを結び付ける」（`accounts.link`。仕様書 第11.12節、ADR-0089）。
 *
 * アプリの利用者と M2Office の利用者を、本人の「お知らせ」に届ける確認コードで結び付ける。結び付いた本人として行う機能
 * （ナレッジの検索・予約・業務の依頼）は、ここで結び付きの ID から本人を引く。
 * 確認コードと結び付きの ID はハッシュだけを持ち、依頼のメールアドレスは持たない。アカウントがあるかを探られないよう、依頼の答えは
 * アカウントの有無にかかわらず同じにし、確定の誤りは理由を分けない。
 */

import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AppBindingView, User } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { AppStore } from './store.js';

/** 確認コードが切れるまで（ミリ秒）。 */
export const LINK_CODE_TTL_MS = 10 * 60_000;
/** 1 つの確認コードで確定を試せる回数。 */
export const LINK_CODE_MAX_ATTEMPTS = 5;
/** 同じメールアドレスへの依頼の、1 時間あたりの上限（お知らせを送り付けられないため）。 */
export const LINK_REQUESTS_PER_HOUR = 5;
/** 結び付きの ID の形（base64url の 32 字）。 */
export const BINDING_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;

/** 結び付けを行うアプリ（名前はお知らせと監査ログに出す）。 */
export interface LinkingApp {
  id: string;
  name: string;
}

/** アカウントの結び付けに要るもの。 */
export interface AppLinksDeps {
  store: AppStore;
  repo: Repository;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

/** メールアドレスの形を確かめて小文字にする。形が違えば `null`。 */
function emailOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && EMAIL.test(e) ? e : null;
}

/**
 * アカウントの結び付け。
 *
 * @remarks テナント境界: どの読み書きも会社の中だけ（不変則 I-2）。結び付きはアプリごとで、ほかのアプリの結び付きの ID では本人を引けない
 */
export class AppLinks {
  /** メールアドレスごとの依頼の時刻（1 時間の上限のため。アドレスはハッシュでだけ持つ）。 */
  private readonly requests = new Map<string, number[]>();

  constructor(private readonly deps: AppLinksDeps) {}

  /**
   * 結び付けの依頼。そのメールアドレスの利用者が会社にいて使える状態なら、本人の「お知らせ」に確認コードを届ける。
   *
   * @returns 形が違えば誤り。それ以外は、アカウントの有無・状態・上限にかかわらず同じ `{ ok: true }`
   * @remarks 確認コードは Chat の控えに写さない（お知らせだけで届ける）
   */
  async request(tenantId: string, app: LinkingApp, emailRaw: unknown, now: Date = new Date()): Promise<{ ok: true } | { error: string; field: string }> {
    const email = emailOf(emailRaw);
    if (!email) return { error: 'email はメールアドレスにしてください', field: 'email' };
    const k = sha(`${tenantId}\u0000${app.id}\u0000${email}`);
    const recent = (this.requests.get(k) ?? []).filter((t) => now.getTime() - t < 3_600_000);
    if (recent.length >= LINK_REQUESTS_PER_HOUR) {
      this.requests.set(k, recent);
      return { ok: true };
    }
    recent.push(now.getTime());
    this.requests.set(k, recent);
    const user = await this.deps.repo.findUserByEmail(tenantId, email);
    if (!user || user.status !== 'active') return { ok: true };
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.deps.store.putLinkRequest(tenantId, app.id, {
      userId: user.id, codeHash: this.codeHash(app.id, user.id, code), attempts: 0,
      expiresAt: new Date(now.getTime() + LINK_CODE_TTL_MS).toISOString(), createdAt: now.toISOString(),
    });
    await this.notify(tenantId, user.id, `${app.name}からアカウントの結び付けの依頼がありました`,
      `確認コード: ${code}（10 分で切れます）。${app.name}の画面に入れると、あなたの M2Office のアカウントと結び付きます。心当たりが無ければ、このお知らせは無視してください。`, now, true);
    return { ok: true };
  }

  /**
   * 結び付けの確定。メールアドレスと確認コードが合えば、結び付きの ID（この答えでだけ見せる）と表示名を返す。
   *
   * @returns 合わない・切れた・回数を超えた・アカウントが無いは、どれも同じ `invalid_code`
   */
  async confirm(tenantId: string, app: LinkingApp, emailRaw: unknown, codeRaw: unknown, now: Date = new Date()): Promise<{ bindingId: string; displayName: string } | { error: 'invalid_code' }> {
    const invalid = { error: 'invalid_code' as const };
    const email = emailOf(emailRaw);
    const code = typeof codeRaw === 'string' ? codeRaw.trim() : '';
    if (!email || !/^\d{6}$/.test(code)) return invalid;
    const user = await this.deps.repo.findUserByEmail(tenantId, email);
    if (!user || user.status !== 'active') return invalid;
    const req = await this.deps.store.getLinkRequest(tenantId, app.id, user.id);
    if (!req) return invalid;
    const attempts = await this.deps.store.bumpLinkAttempt(tenantId, app.id, user.id);
    if (attempts > LINK_CODE_MAX_ATTEMPTS || Date.parse(req.expiresAt) <= now.getTime()) {
      await this.deps.store.deleteLinkRequest(tenantId, app.id, user.id);
      return invalid;
    }
    const a = Buffer.from(req.codeHash, 'hex');
    const b = Buffer.from(this.codeHash(app.id, user.id, code), 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return invalid;
    await this.deps.store.deleteLinkRequest(tenantId, app.id, user.id);
    const bindingId = randomBytes(24).toString('base64url');
    const id = randomUUID();
    const at = now.toISOString();
    await this.deps.store.createBinding(tenantId, { id, appId: app.id, userId: user.id, bindingHash: sha(bindingId), createdAt: at, lastUsedAt: null });
    await this.notify(tenantId, user.id, `${app.name}と結び付きました`,
      `${app.name}から、あなたの権限で M2Office を使えるようになりました。やめるときは、個人設定の「サービスとの接続」で削除できます。`, now, false);
    await this.audit(tenantId, `app:${app.id}`, 'api_client', 'app.binding.create', app, { userId: user.id }, at);
    return { bindingId, displayName: user.displayName };
  }

  /** アプリの側から結び付きを消す。知らない ID でも何もしない（アプリが後片付けで呼べるように）。 */
  async unlink(tenantId: string, app: LinkingApp, bindingId: string, now: Date = new Date()): Promise<void> {
    if (!BINDING_ID_PATTERN.test(bindingId)) return;
    const b = await this.deps.store.findBinding(tenantId, app.id, sha(bindingId));
    if (!b || !(await this.deps.store.deleteBinding(tenantId, b.id))) return;
    await this.audit(tenantId, `app:${app.id}`, 'api_client', 'app.binding.delete', app, { userId: b.userId, by: 'app' }, now.toISOString());
  }

  /**
   * 結び付きの ID から本人を引く。結び付きが無い・本人のアカウントが止まっている・無いときは `null`（呼ぶ側は 410 にする）。
   */
  async resolve(tenantId: string, appId: string, bindingId: unknown, now: Date = new Date()): Promise<User | null> {
    if (typeof bindingId !== 'string' || !BINDING_ID_PATTERN.test(bindingId)) return null;
    const b = await this.deps.store.findBinding(tenantId, appId, sha(bindingId));
    if (!b) return null;
    const user = await this.deps.repo.findUserById(tenantId, b.userId);
    if (!user || user.status !== 'active') return null;
    await this.deps.store.touchBinding(tenantId, b.id, now.toISOString()).catch(() => undefined);
    return user;
  }

  /** 本人の結び付き（個人設定の「サービスとの接続」）。 */
  async listForUser(tenantId: string, userId: string): Promise<AppBindingView[]> {
    const [rows, apps] = await Promise.all([this.deps.store.listBindingsOfUser(tenantId, userId), this.deps.store.listApps(tenantId)]);
    const names = new Map(apps.map((a) => [a.id, a.name]));
    return rows.filter((b) => names.has(b.appId)).map((b) => ({ id: b.id, appName: names.get(b.appId)!, createdAt: b.createdAt, lastUsedAt: b.lastUsedAt }));
  }

  /** 本人の側から結び付きを消す。本人のものでなければ `false`。 */
  async removeForUser(tenantId: string, userId: string, id: string, now: Date = new Date()): Promise<boolean> {
    const b = (await this.deps.store.listBindingsOfUser(tenantId, userId)).find((x) => x.id === id);
    if (!b || !(await this.deps.store.deleteBinding(tenantId, b.id))) return false;
    const app = await this.deps.store.getApp(tenantId, b.appId);
    await this.audit(tenantId, userId, 'user', 'app.binding.delete', { id: b.appId, name: app?.name ?? '' }, { userId, by: 'user' }, now.toISOString());
    return true;
  }

  private codeHash(appId: string, userId: string, code: string): string {
    return sha(`${appId}\u0000${userId}\u0000${code}`);
  }

  /** 本人のお知らせに届ける。確認コードは Chat の控えに写さない（届け終えた印を先に付ける）。 */
  private async notify(tenantId: string, userId: string, title: string, body: string, now: Date, secret: boolean): Promise<void> {
    const id = randomUUID();
    await this.deps.repo.createNotification({ id, tenantId, userId, kind: 'security', title, body, runId: null, readAt: null, createdAt: now.toISOString() });
    if (secret) await this.deps.repo.markNotificationDelivered(tenantId, id, now.toISOString(), '確認コードのため、ほかの届け先には写しません');
  }

  private async audit(tenantId: string, actorId: string, actorType: 'user' | 'api_client', action: string, app: LinkingApp, detail: Record<string, unknown>, at: string): Promise<void> {
    await this.deps.repo.appendAudit({
      id: randomUUID(), tenantId, actorType, actorId, action, targetType: 'external_app', targetId: app.id, detail: { name: app.name, ...detail }, occurredAt: at,
    });
  }
}
