/**
 * @file 不正の兆しの見張り（仕様書 第16.8節、ADR-0091）。ワーカーが 5 分ごとに監査ログとログイン中の端末を読み、
 * 決まった規則で兆しを見つけて、管理者に「セキュリティ」のお知らせで知らせる。
 *
 * - 兆し: 大量の持ち出し（書き出し・一斉メール）・ログインの攻撃（拒否が続く・止めたアカウント・止めた人の端末）・
 *   権限の変化（管理者が増えた・権限の変更が続く）・ありえない並び（同じ種類の端末 2 つが同時に使われる。まず本人に知らせる）
 * - ふだんと違う時間（深夜・休業日）は、単独では知らせず、重さを 1 段上げるだけに使う（深夜に働く人を見張らないため）
 * - 同じ人に 1 時間のうちに、まとまりの違う重さ高が 2 つ重なったら（持ち出しと権限の変化など）、その人の端末を自動ですべてログアウトする
 *   （アカウントは止めない。Q-218）
 * - ログインの拒否が同じアドレスで 10 分に 5 回に達したら、そのアドレスのログインを 30 分受けない（Q-219）
 *
 * 判定に推論を使わない。場所・IP を持たず、1 人ずつのログイン時刻を集計しない（第6.7.10節）。中身は知らせにも記録にも入れない。
 */

import { randomUUID } from 'node:crypto';
import type { AuditEvent, User } from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import { closedReason } from '../scheduler/business-days.js';
import { deviceOf } from '../dashboard/presence.js';
import type { SecuritySignal, SecuritySignalType, SecurityStore } from './store.js';

/** 1 回で大量とみなす書き出し・一斉メールの件数。 */
export const SECURITY_EXPORT_ROWS = 500;
/** 同じ人の 1 時間の書き出しの回数。 */
export const SECURITY_EXPORT_BURST = 3;
/** 同じアドレスの 10 分のログインの拒否の回数（締め出しの境目でもある）。 */
export const SECURITY_LOGIN_BURST = 5;
/** 会社全体の 1 時間のログインの拒否の回数。 */
export const SECURITY_LOGIN_FLOOD = 20;
/** 同じ人の 10 分の権限の変更の回数。 */
export const SECURITY_PERMISSION_BURST = 5;
/** ログインの締め出しの長さ（ミリ秒）。 */
export const SECURITY_LOCK_MS = 30 * 60_000;
/** 「これは大丈夫」で知らせない長さ（ミリ秒）。 */
export const SECURITY_SUPPRESS_MS = 30 * 86_400_000;

const MIN = 60_000;
const HOUR = 60 * MIN;

/** 書き出し・持ち出しの操作。 */
const EXPORT_ACTIONS = ['contact.export', 'inventory.export', 'hr.export', 'hr.books.export', 'audit.export', 'print.export'];
/** 権限の変更の操作（頭）。 */
const PERMISSION_PREFIXES = ['user.invite', 'user.update', 'settings.update', 'compartment.', 'group.', 'extension.install', 'extension.uninstall',
  'app.create', 'app.approve', 'app.rekey', 'app.resume', 'connection.'];

/** 不正の兆しの見張りに要るもの。 */
export interface SecurityWatchDeps {
  repo: Repository;
  store: SecurityStore;
  /** 休業の期間か（お知らせの作成で覚えた休業。第6.6.1節）。 */
  closedOn?: (tenantId: string, day: string) => Promise<boolean>;
}

/** 見回りの結果。 */
export interface SecurityScanResult {
  found: SecuritySignal[];
  /** 自動でログアウトさせた人。 */
  signedOut: string[];
}

/** 秘書に見せる兆し（人の名前を添える）。 */
export interface SecuritySignalView extends SecuritySignal {
  userName: string | null;
}

/** 日本時間の日付と時。 */
function jst(at: string | Date): { day: string; hour: number } {
  const d = new Date(new Date(at).getTime() + 9 * HOUR);
  return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}
const hourBucket = (now: Date) => Math.floor(now.getTime() / HOUR);
const countOf = (e: AuditEvent): number => {
  const d = e.detail ?? {};
  for (const k of ['count', 'rows', 'items', 'recipients']) if (typeof d[k] === 'number') return d[k] as number;
  return 0;
};
/** 兆しのまとまり（自動でログアウトするのは、まとまりの違う重さ高が 2 つ重なったときだけ。1 つの行動を二重に数えない）。 */
const FAMILY: Record<SecuritySignalType, string> = {
  export: 'exfiltration', export_burst: 'exfiltration', bulk_mail: 'exfiltration',
  login_disabled: 'login', session_disabled: 'login', login_burst: 'login', login_flood: 'login',
  admin_added: 'permission', permission_burst: 'permission', new_device: 'device', auto_signout: 'response',
};
const isUser = (e: AuditEvent) => e.actorType === 'user' && !e.actorId.startsWith('app:') && e.actorId !== 'system';

/** 兆しの型の言い方（知らせと秘書）。 */
export const SECURITY_SIGNAL_LABELS: Record<SecuritySignalType, string> = {
  export: '大きな書き出し', export_burst: '書き出しが続いた', bulk_mail: '大量の一斉メール',
  login_disabled: '止めたアカウントでのログインの試み', session_disabled: '止めた人の端末からの呼び出し',
  login_burst: 'ログインの拒否が続いた', login_flood: 'ログインの拒否が多い',
  admin_added: '管理者が増えた', permission_burst: '権限の変更が続いた', new_device: '新しい端末でのログイン',
  auto_signout: '自動でログアウトさせた',
};

/**
 * 不正の兆しの見張り。
 *
 * @remarks テナント境界: 会社ごとに監査ログと端末を読み、その会社の管理者にだけ知らせる（不変則 I-2）
 */
export class SecurityWatch {
  constructor(private readonly deps: SecurityWatchDeps) {}

  /** ふだんと違う時間か（深夜 22 時〜5 時・休業日）。 */
  private async offHours(tenantId: string, at: string): Promise<boolean> {
    const { day, hour } = jst(at);
    if (hour >= 22 || hour < 5) return true;
    const settings = await this.deps.repo.getTenantSettings(tenantId);
    const closed = this.deps.closedOn ? await this.deps.closedOn(tenantId, day).catch(() => false) : false;
    return closedReason(settings.company, day, closed) !== null;
  }

  /**
   * 1 回の見回り（ワーカーが 5 分ごとに呼ぶ）。
   *
   * @returns 新しく見つけた兆しと、自動でログアウトさせた人
   */
  async scan(tenantId: string, now: Date = new Date()): Promise<SecurityScanResult> {
    const from = new Date(now.getTime() - 70 * MIN).toISOString();
    const events = await this.deps.repo.searchAudit(tenantId, {
      from, to: now.toISOString(), limit: 2000,
      actions: [...EXPORT_ACTIONS, 'bulk_mail.start', 'auth.login.denied', 'auth.session.denied', ...PERMISSION_PREFIXES],
    });
    const users = await this.deps.repo.listUsers(tenantId);
    const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));
    const drafts: { type: SecuritySignalType; severity: 'high' | 'medium'; userId: string | null; key: string; at: string; detail: Record<string, unknown>; self?: boolean }[] = [];
    const within = (e: AuditEvent, ms: number) => now.getTime() - Date.parse(e.occurredAt) <= ms;

    // 1. 大量の持ち出し
    const exports = events.filter((e) => EXPORT_ACTIONS.includes(e.action) && isUser(e));
    for (const e of exports) {
      if (countOf(e) >= SECURITY_EXPORT_ROWS) drafts.push({ type: 'export', severity: 'high', userId: e.actorId, key: e.id, at: e.occurredAt, detail: { action: e.action, count: countOf(e) } });
    }
    for (const e of events.filter((x) => x.action === 'bulk_mail.start' && isUser(x))) {
      if (countOf(e) >= SECURITY_EXPORT_ROWS) drafts.push({ type: 'bulk_mail', severity: 'high', userId: e.actorId, key: e.id, at: e.occurredAt, detail: { count: countOf(e) } });
    }
    for (const [actor, list] of groupBy(exports.filter((e) => within(e, HOUR)), (e) => e.actorId)) {
      if (list.length >= SECURITY_EXPORT_BURST) {
        const first = list.reduce((a, b) => (a.occurredAt < b.occurredAt ? a : b));
        drafts.push({ type: 'export_burst', severity: 'high', userId: actor, key: first.id, at: list.at(-1)!.occurredAt, detail: { times: list.length } });
      }
    }

    // 3. ログインの攻撃
    const denials = events.filter((e) => e.action === 'auth.login.denied');
    for (const e of denials) {
      if (e.detail?.['kind'] === 'disabled') {
        const u = byEmail.get(String(e.targetId).toLowerCase());
        drafts.push({ type: 'login_disabled', severity: 'high', userId: u?.id ?? null, key: e.id, at: e.occurredAt, detail: {} });
      }
    }
    for (const [email, list] of groupBy(denials.filter((e) => within(e, 10 * MIN)), (e) => String(e.targetId).toLowerCase())) {
      if (list.length >= SECURITY_LOGIN_BURST) {
        drafts.push({ type: 'login_burst', severity: 'medium', userId: byEmail.get(email)?.id ?? null, key: `${email}:${hourBucket(now)}`, at: list.at(-1)!.occurredAt, detail: { times: list.length, email } });
      }
    }
    const hourDenials = denials.filter((e) => within(e, HOUR));
    if (hourDenials.length >= SECURITY_LOGIN_FLOOD) {
      drafts.push({ type: 'login_flood', severity: 'medium', userId: null, key: `flood:${hourBucket(now)}`, at: now.toISOString(), detail: { times: hourDenials.length } });
    }
    for (const e of events.filter((x) => x.action === 'auth.session.denied')) {
      drafts.push({ type: 'session_disabled', severity: 'high', userId: e.targetId || null, key: e.id, at: e.occurredAt, detail: {} });
    }

    // 4. 権限の変化
    const perms = events.filter((e) => PERMISSION_PREFIXES.some((p) => e.action.startsWith(p)) && isUser(e)
      && !(e.action === 'settings.update' && !['access', 'agents', 'automation', 'aiPolicy'].includes(e.targetId)));
    for (const e of perms) {
      const roles = Array.isArray(e.detail?.['roles']) ? e.detail['roles'] as string[] : [];
      const before = Array.isArray(e.detail?.['rolesBefore']) ? e.detail['rolesBefore'] as string[] : null;
      const added = roles.includes('admin') && (e.action === 'user.invite' || (e.action === 'user.update' && before !== null && !before.includes('admin')));
      if (added) drafts.push({ type: 'admin_added', severity: 'high', userId: e.actorId, key: e.id, at: e.occurredAt, detail: { newAdmin: e.targetId } });
    }
    for (const [actor, list] of groupBy(perms.filter((e) => within(e, 10 * MIN)), (e) => e.actorId)) {
      if (list.length >= SECURITY_PERMISSION_BURST) {
        const first = list.reduce((a, b) => (a.occurredAt < b.occurredAt ? a : b));
        drafts.push({ type: 'permission_burst', severity: 'high', userId: actor, key: first.id, at: list.at(-1)!.occurredAt, detail: { times: list.length } });
      }
    }

    // 5. ありえない並び（同じ人の同じ種類の端末 2 つが 5 分の間にどちらも使われ、片方が 24 時間以内に作られた）
    const sessions = await this.deps.store.liveSessions(tenantId, now.toISOString());
    for (const [userId, list] of groupBy(sessions.filter((s) => now.getTime() - Date.parse(s.lastSeenAt) <= 5 * MIN), (s) => s.userId)) {
      for (const [, same] of groupBy(list, (s) => deviceOf(s.userAgent) ?? 'unknown')) {
        if (same.length < 2) continue;
        const newest = same.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
        if (now.getTime() - Date.parse(newest.createdAt) > 24 * HOUR) continue;
        drafts.push({ type: 'new_device', severity: 'medium', userId, key: newest.id, at: newest.createdAt, detail: { device: deviceOf(newest.userAgent) ?? '端末' }, self: true });
      }
    }

    // 2. ふだんと違う時間は重さを 1 段上げる。「これは大丈夫」と言われた人と型は知らせない
    const found: SecuritySignal[] = [];
    for (const d of drafts) {
      if (d.userId && await this.deps.store.isSuppressed(tenantId, d.userId, d.type, now.toISOString())) continue;
      const off = await this.offHours(tenantId, d.at);
      const severity = off ? 'high' : d.severity;
      const s: SecuritySignal = { id: randomUUID(), type: d.type, severity, userId: d.userId, key: d.key, detail: { ...d.detail, ...(off ? { offHours: true } : {}) }, createdAt: now.toISOString() };
      if (!(await this.deps.store.addSignal(tenantId, s))) continue;
      found.push(s);
      await this.audit(tenantId, 'security.signal', s);
      // 新しい端末は本人に知らせる。書き出し・権限の変化と重なれば管理者にも
      if (d.self && d.userId) {
        await this.notifySelf(tenantId, d.userId, s, now);
        const overlap = found.concat(await this.deps.store.recentSignals(tenantId, new Date(now.getTime() - HOUR).toISOString()))
          .some((x) => x.userId === d.userId && ['export', 'export_burst', 'bulk_mail', 'admin_added', 'permission_burst'].includes(x.type));
        if (overlap || severity === 'high') await this.notifyAdmins(tenantId, users, s, now);
      } else {
        await this.notifyAdmins(tenantId, users, s, now);
      }
    }

    // 同じ人に 1 時間のうちに、まとまりの違う重さ高が 2 つ重なったら、その人の端末を自動ですべてログアウトする（Q-218）
    const signedOut: string[] = [];
    const recent = await this.deps.store.recentSignals(tenantId, new Date(now.getTime() - HOUR).toISOString(), 200);
    for (const [userId, list] of groupBy(recent.filter((s) => s.userId && s.severity === 'high' && s.type !== 'auto_signout'), (s) => s.userId!)) {
      if (new Set(list.map((s) => FAMILY[s.type])).size < 2) continue;
      if (recent.some((s) => s.type === 'auto_signout' && s.userId === userId)) continue;
      const n = await this.signOutAll(tenantId, userId, now);
      const s: SecuritySignal = {
        id: randomUUID(), type: 'auto_signout', severity: 'high', userId, key: `${userId}:${hourBucket(now)}`,
        detail: { sessions: n, because: [...new Set(list.map((x) => x.type))] }, createdAt: now.toISOString(),
      };
      if (!(await this.deps.store.addSignal(tenantId, s))) continue;
      signedOut.push(userId);
      found.push(s);
      await this.audit(tenantId, 'security.auto_signout', s);
      await this.notifyAdmins(tenantId, users, s, now);
    }
    return { found, signedOut };
  }

  /**
   * ログインの締め出しの間か（同じアドレスの拒否が 10 分に 5 回に達してから 30 分。Q-219）。
   */
  async loginLocked(tenantId: string, email: string, now: Date = new Date()): Promise<boolean> {
    return (await this.deps.store.countAudit(tenantId, 'auth.login.locked', email.toLowerCase(), new Date(now.getTime() - SECURITY_LOCK_MS).toISOString())) > 0;
  }

  /**
   * ログインの拒否を記録したあとに呼ぶ。同じアドレスの拒否が 10 分に 5 回に達したら締め出す（監査ログ `auth.login.locked`）。
   *
   * @returns 締め出したら `true`
   */
  async afterDenial(tenantId: string, email: string, now: Date = new Date()): Promise<boolean> {
    const e = email.toLowerCase();
    if (await this.loginLocked(tenantId, e, now)) return false;
    const n = await this.deps.store.countAudit(tenantId, 'auth.login.denied', e, new Date(now.getTime() - 10 * MIN).toISOString());
    if (n < SECURITY_LOGIN_BURST) return false;
    await this.deps.repo.appendAudit({
      id: randomUUID(), tenantId, actorType: 'system', actorId: 'security-watch', action: 'auth.login.locked', targetType: 'connection', targetId: e,
      detail: { denials: n, minutes: SECURITY_LOCK_MS / MIN }, occurredAt: now.toISOString(),
    });
    return true;
  }

  /** 最近の兆し（秘書の「セキュリティの知らせは？」。人の名前を添える）。 */
  async recent(tenantId: string, now: Date = new Date(), days = 7): Promise<SecuritySignalView[]> {
    const [list, users] = await Promise.all([
      this.deps.store.recentSignals(tenantId, new Date(now.getTime() - days * 86_400_000).toISOString(), 30), this.deps.repo.listUsers(tenantId),
    ]);
    const names = new Map(users.map((u) => [u.id, u.displayName]));
    return list.map((s) => ({ ...s, userName: s.userId ? names.get(s.userId) ?? null : null }));
  }

  /**
   * 「これは大丈夫」。同じ人・同じ型の兆しを 30 日知らせない（ADR-0028）。
   *
   * @param userId 対象の人（省けば、いちばん新しい兆しの人と型）
   * @returns 知らせないことにした兆し。当たるものが無ければ `null`
   */
  async dismiss(tenantId: string, adminId: string, userId: string | null, now: Date = new Date()): Promise<SecuritySignalView | null> {
    const list = (await this.recent(tenantId, now, 1)).filter((s) => s.userId && s.type !== 'auto_signout' && (!userId || s.userId === userId));
    const s = list[0];
    if (!s || !s.userId) return null;
    await this.deps.store.suppress(tenantId, s.userId, s.type, new Date(now.getTime() + SECURITY_SUPPRESS_MS).toISOString(), adminId);
    await this.deps.repo.appendAudit({
      id: randomUUID(), tenantId, actorType: 'user', actorId: adminId, action: 'security.dismiss', targetType: 'user', targetId: s.userId,
      detail: { type: s.type, days: SECURITY_SUPPRESS_MS / 86_400_000 }, occurredAt: now.toISOString(),
    });
    return s;
  }

  /**
   * 管理者の依頼で、その人の端末をすべてログアウトする（秘書の「〇〇さんの端末をすべてログアウトして」）。
   *
   * @returns ログアウトさせた端末の数
   */
  async signOut(tenantId: string, adminId: string, userId: string, now: Date = new Date()): Promise<number> {
    const n = await this.signOutAll(tenantId, userId, now);
    await this.deps.repo.appendAudit({
      id: randomUUID(), tenantId, actorType: 'user', actorId: adminId, action: 'security.signout', targetType: 'user', targetId: userId,
      detail: { sessions: n }, occurredAt: now.toISOString(),
    });
    return n;
  }

  /**
   * 前の日の兆しの数を、朝に 1 通にまとめて管理者に知らせる（無ければ送らない）。
   *
   * @returns 数
   */
  async dailyDigest(tenantId: string, now: Date = new Date()): Promise<number> {
    const today = jst(now).day;
    const start = new Date(Date.parse(`${today}T00:00:00+09:00`) - 86_400_000).toISOString();
    const list = (await this.deps.store.recentSignals(tenantId, start, 500)).filter((s) => s.createdAt < new Date(Date.parse(`${today}T00:00:00+09:00`)).toISOString());
    if (list.length === 0) return 0;
    const byType = [...groupBy(list, (s) => s.type)].map(([t, xs]) => `${SECURITY_SIGNAL_LABELS[t as SecuritySignalType]} ${xs.length} 件`).join('・');
    const admins = (await this.deps.repo.listUsers(tenantId)).filter(isAdmin);
    for (const a of admins) {
      await this.deps.repo.createNotification({
        id: randomUUID(), tenantId, userId: a.id, kind: 'security', title: `昨日のセキュリティの兆し ${list.length} 件`,
        body: `${byType}。秘書に「セキュリティの知らせは？」と聞くと、1 件ずつ説明します。`, runId: null, readAt: null, createdAt: now.toISOString(),
      });
    }
    return list.length;
  }

  private async signOutAll(tenantId: string, userId: string, now: Date): Promise<number> {
    const sessions = await this.deps.repo.listSessions(tenantId, userId, now);
    for (const s of sessions) await this.deps.repo.revokeSession(tenantId, s.id, now);
    return sessions.length;
  }

  private async notifyAdmins(tenantId: string, users: User[], s: SecuritySignal, now: Date): Promise<void> {
    const names = new Map(users.map((u) => [u.id, u.displayName]));
    const { title, body } = messageOf(s, (id) => names.get(id) ?? '（名前の分からない人）');
    // 兆しの本人が管理者でも、ほかの管理者には必ず届く（乗っ取られた管理者のアカウントで握りつぶせないように）
    for (const a of users.filter(isAdmin)) {
      await this.deps.repo.createNotification({ id: randomUUID(), tenantId, userId: a.id, kind: 'security', title, body, runId: null, readAt: null, createdAt: now.toISOString() });
    }
  }

  private async notifySelf(tenantId: string, userId: string, s: SecuritySignal, now: Date): Promise<void> {
    const device = String(s.detail['device'] ?? '端末');
    await this.deps.repo.createNotification({
      id: randomUUID(), tenantId, userId, kind: 'security', title: `新しい${device}でログインしました`,
      body: `ほかの${device}でも使っている間に、新しい${device}でのログインがありました（${jstText(s.createdAt)}）。覚えが無ければ、個人設定の「ログイン中の端末」でその端末をログアウトし、管理者に知らせてください。`,
      runId: null, readAt: null, createdAt: now.toISOString(),
    });
  }

  private async audit(tenantId: string, action: string, s: SecuritySignal): Promise<void> {
    await this.deps.repo.appendAudit({
      id: randomUUID(), tenantId, actorType: 'system', actorId: 'security-watch', action, targetType: 'user', targetId: s.userId ?? '',
      detail: { type: s.type, severity: s.severity, ...pickCounts(s.detail) }, occurredAt: s.createdAt,
    });
  }
}

const isAdmin = (u: User) => u.status === 'active' && u.roles.includes('admin');

/** 記録に残すのは数と時間の帯だけ（メールアドレスや中身は入れない）。 */
function pickCounts(d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['count', 'times', 'sessions', 'offHours', 'action', 'because']) if (d[k] !== undefined) out[k] = d[k];
  return out;
}

function jstText(at: string): string {
  return new Date(at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** 管理者への知らせの題と本文（何が・いつ・誰に・考えられること・勧める対応）。中身と場所は入れない。 */
export function messageOf(s: SecuritySignal, nameOf: (id: string) => string): { title: string; body: string } {
  const who = s.userId ? `${nameOf(s.userId)}さん` : '誰か';
  const when = jstText(s.createdAt);
  const off = s.detail['offHours'] ? '（深夜か休業日）' : '';
  const n = Number(s.detail['count'] ?? s.detail['times'] ?? 0);
  const action = '覚えが無ければ、秘書に「' + (s.userId ? `${nameOf(s.userId)}さんの端末をすべてログアウトして` : 'セキュリティの知らせは？') + '」と頼めます。問題が無ければ「これは大丈夫」と伝えてください。';
  const label = SECURITY_SIGNAL_LABELS[s.type];
  switch (s.type) {
    case 'export':
      return { title: `${label}: ${who}`, body: `${who}が ${n.toLocaleString('ja-JP')} 件を書き出しました${off}（${when}）。内部の人による持ち出しや、乗っ取られたアカウントのことがあります。${action}` };
    case 'export_burst':
      return { title: `${label}: ${who}`, body: `${who}が 1 時間に ${n} 回書き出しました${off}（${when}）。持ち出しや乗っ取りのことがあります。${action}` };
    case 'bulk_mail':
      return { title: `${label}: ${who}`, body: `${who}が ${n.toLocaleString('ja-JP')} 件の一斉メールを始めました${off}（${when}）。乗っ取られたアカウントでの送信のことがあります。${action}` };
    case 'login_disabled':
      return { title: label, body: `止めたアカウント（${who}）でログインしようとした人がいます${off}（${when}）。退職した人や、アカウントの乗っ取りの試みのことがあります。ログインはできていません。` };
    case 'session_disabled':
      return { title: label, body: `止めた人（${who}）の端末に残っていたログインで、M2Office が呼ばれました${off}（${when}）。呼び出しは断りました。端末をログアウトさせるには、秘書に「${s.userId ? nameOf(s.userId) : ''}さんの端末をすべてログアウトして」と頼めます。` };
    case 'login_burst':
      return { title: label, body: `同じアドレスでのログインの拒否が 10 分に ${n} 回ありました${off}（${when}）。総当たりの試みのことがあります。そのアドレスのログインは 30 分受けません。` };
    case 'login_flood':
      return { title: label, body: `この 1 時間に、ログインの拒否が ${n} 回ありました${off}（${when}）。多くのアドレスを試す攻撃のことがあります。会社の人のログインには影響していません。` };
    case 'admin_added':
      return { title: `${label}: ${who}が追加`, body: `${who}が管理者を追加しました${off}（${when}）。乗っ取りや内部の人の不正のことがあります。覚えが無ければ、管理者ページの「ユーザーと権限」で確かめてください。${action}` };
    case 'permission_burst':
      return { title: `${label}: ${who}`, body: `${who}が 10 分に ${n} 件の権限の変更をしました${off}（${when}）。乗っ取りや内部の人の不正のことがあります。監査ログで中身を確かめられます。${action}` };
    case 'new_device':
      return { title: `${label}: ${who}`, body: `${who}が、ほかの端末を使っている間に、新しい端末でログインしました${off}（${when}）。アカウントの貸し借りや乗っ取りのことがあります。${action}` };
    case 'auto_signout':
      return { title: `${label}: ${who}`, body: `${who}に重い兆しが重なったため、その人の端末をすべてログアウトさせました（${when}）。アカウントは止めていません。止めるときは、管理者ページの「ユーザーと権限」で行います。` };
  }
}

function groupBy<T>(list: T[], keyOf: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of list) {
    const k = keyOf(x);
    out.set(k, [...(out.get(k) ?? []), x]);
  }
  return out;
}
