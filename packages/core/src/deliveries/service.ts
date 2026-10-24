/**
 * @file 外部のアプリからの配信の依頼（仕様書 第13.4.4節、Q-254）。
 *
 * 外部のアプリ（最初は M2Medical の「声掛け」）が渡した文を、M2Office の承認のあと（社内のアドレスへのテスト送信だけは承認なし）、
 * 会社の窓口のアカウントから 1 人に 1 通ずつ送る。結果と配信の停止は、アプリが取りに来る（M2Office からアプリへは送らない）。
 * 案内文の作成・送る相手・配信の記録はアプリが持つ。クラウドの形でもローカルの形でも同じ。
 *
 * - 宛先（名前・アドレス）は暗号化して持ち、**その人に送り終えたら消す**。照合の値（アドレスの SHA-256）は 3 日、結果と停止は 30 日で消す。
 *   **秘書・推論・会社の接続（MCP）には渡さない**。承認の画面にも宛先の一覧は出さない（人数と見本だけ）。監査ログとシステムログにも出さない
 * - 差し込み（`{{name}}`・`values`・`{{unsubscribe_url}}`・`{{unsubscribe_address}}`）はプログラムで行う。中身は書き換えない
 * - 配信の停止は、宛先の ID を付けた窓口のアカウントへの返信（`窓口+stop-<ID>@…`）で受ける（院外の患者が開けるページを持たないため）
 * - 差出人は、アプリの設定で選んだ窓口のアカウントの送信元（無ければ本来のアドレス）。送信元から外れたら送らずに止めて知らせる（第33.24節）
 * - 1 回 500 人・窓口のアカウントから 1 日 1,000 通まで。その日の残りを超える分は、あとで続けて送る
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  DELIVERY_DAILY_LIMIT, DELIVERY_DONE_AFTER_HOURS, DELIVERY_GAP_SECONDS, DELIVERY_HASH_KEEP_DAYS, DELIVERY_KEEP_DAYS, DELIVERY_LOGO_MAX_BYTES,
  DELIVERY_MAX_RECIPIENTS, DELIVERY_PAGE_SIZE,
  type DeliveryFailReason, type DeliveryRejectCode, type DeliveryResult, type DeliveryResultsPage, type DeliveryStopsPage, type DeliveryView,
} from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { AppRecord } from '../apps/store.js';
import type { Mailbox, MailItem } from '../inquiries/mailbox.js';
import { MailboxUnavailableError } from '../inquiries/mailbox.js';
import type { DeliveryRecord, DeliveryStore, RecipientRecord } from './store.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** 窓口のアカウントの送った数を Gmail に問い直す間。 */
const QUOTA_REFRESH_MS = 10 * MIN;

/** 配信の依頼に要るもの。 */
export interface DeliveryDeps {
  store: DeliveryStore;
  repo: Repository;
  box: { encrypt(v: string): string; decrypt(v: string): string };
  /** 外部のアプリ（承認した機能と設定）。 */
  apps: { get(tenantId: string, appId: string): Promise<AppRecord | null> };
  /** 会社の窓口のアカウント（預けていなければ `null`）。 */
  mailbox: (tenantId: string) => Promise<Mailbox | null>;
  /**
   * 承認の業務を始め、実行の ID を返す（承認トレイに出す。業務「外部のアプリからの配信」）。
   *
   * @throws AI の利用の上限などで始められないとき
   */
  startApproval?: (tenantId: string, deliveryId: string, requestedBy: string) => Promise<string>;
  logger?: { info(msg: string, f?: Record<string, unknown>): void; warn(msg: string, f?: Record<string, unknown>): void };
}

/** 受け付けの答え（API がそのまま返す）。 */
export type DeliveryAcceptResult =
  | { ok: true; deliveryId: string; status: DeliveryRecord['status'] }
  | { ok: false; status: 400 | 404 | 409 | 422; code: DeliveryRejectCode; error: string };

/** アドレスの SHA-256（小文字にしてから）。 */
export const emailHash = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

/** 差し込みの名前（`{{ name }}`）。 */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** M2Office が差し込む名前（依頼の `values` には入れられない）。 */
const RESERVED = ['name', 'unsubscribe_url', 'unsubscribe_address'];

/** 宛先の ID の形（返信の宛先に入れるため、英数字と `-`・`_` の 64 文字まで）。 */
const RECIPIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** 文の型に出てくる差し込みの名前。 */
export function placeholdersOf(...texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(PLACEHOLDER)) out.add(m[1]!);
  return [...out];
}

const escapeHtml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * 差し込む（HTML のときは値を HTML の文字に直す）。知らない名前はそのまま残す（受け付けの段で断っている）。
 *
 * @remarks 推論を使わない。値の中の `{{…}}` は差し込み直さない（1 回だけ置き換える）
 */
export function renderTemplate(template: string, vars: Record<string, string>, html: boolean): string {
  return template.replace(PLACEHOLDER, (all, key: string) => (key in vars ? (html ? escapeHtml(vars[key]!) : vars[key]!) : all));
}

/**
 * 配信の停止の返信の宛先（`mailto:窓口+stop-<宛先の ID>@ドメイン?subject=配信停止`）。
 * `@` の前が 64 文字を超えるときは、`+` を付けない窓口のアドレスにする（返信は差出人のアドレスで照らす）。
 */
export function unsubscribeAddress(mailboxAddress: string, recipientId?: string): string {
  const at = mailboxAddress.lastIndexOf('@');
  const local = mailboxAddress.slice(0, at);
  const tagged = recipientId && at > 0 && `${local}+stop-${recipientId}`.length <= 64 ? `${local}+stop-${recipientId}${mailboxAddress.slice(at)}` : mailboxAddress;
  return `mailto:${tagged}?subject=${encodeURIComponent('配信停止')}`;
}

/**
 * 返信の宛先から、配信の停止の宛先の ID を読む（窓口のアカウントのアドレスか送信元の別名に付いた `+stop-<ID>` だけ）。
 *
 * @param mailboxAddresses 窓口のアカウントの本来のアドレスと送信元の別名（差出人に選べるもの）
 */
export function stopRecipientOf(to: string[], mailboxAddresses: string | string[]): string | null {
  const own = new Set((Array.isArray(mailboxAddresses) ? mailboxAddresses : [mailboxAddresses]).map((a) => a.toLowerCase()));
  for (const addr of to) {
    const m = /^(.+)\+stop-([A-Za-z0-9_-]{1,64})@(.+)$/i.exec(addr.trim());
    if (m && own.has(`${m[1]!.toLowerCase()}@${m[3]!.toLowerCase()}`)) return m[2]!;
  }
  return null;
}

/** 配信の停止の返信か（件名か本文の頭に「配信停止」など）。 */
export function isStopReply(subject: string, body: string): boolean {
  const head = `${subject}\n${body.slice(0, 400)}`.normalize('NFKC');
  return /配信(を)?(停止|解除|不要)|停止(を)?希望|送らないで|unsubscribe/i.test(head);
}

/** 送れなかった知らせ（Gmail の Mail Delivery Subsystem など）か。 */
export function isBounce(fromAddress: string, subject: string): boolean {
  return /^(mailer-daemon|postmaster)@/i.test(fromAddress) || /Delivery Status Notification|Undeliver|Mail delivery failed|配信できませんでした|返送/i.test(subject);
}

/** 送れなかった知らせの中の、元のメールの見出し `X-M2O-Recipient` の宛先の ID。 */
export function bouncedRecipientOf(body: string): string | null {
  return /X-M2O-Recipient:\s*([A-Za-z0-9_-]{1,64})/i.exec(body)?.[1] ?? null;
}

const EMAIL = /^[^\s@<>()",;:]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** 印（`after`）を読む。無ければ 0、形が違えば `null`。 */
function cursorOf(after: string | null): number | null {
  if (after === null || after === '') return 0;
  return /^\d{1,15}$/.test(after) ? Number(after) : null;
}

/**
 * 外部のアプリからの配信の依頼。
 *
 * @remarks テナント境界: 依頼を受けた会社の中だけを読み書きし、その会社の窓口のアカウントから送る（不変則 I-2）。
 * 結果と停止は、そのアプリが頼んだ配信のものだけを渡す
 */
export class DeliveryService {
  /** 会社ごとの、窓口のアカウントから今日（過ぎた 24 時間）送ってよい残りの数と、問い直した時刻。 */
  private readonly quota = new Map<string, { left: number; at: number; pausedUntil: number }>();
  /** 配信ごとの、最後に送った時刻（1 通ごとに間を空ける）。 */
  private readonly lastSent = new Map<string, number>();
  /** 差出人が送信元から外れたと管理者に知らせた配信（同じ配信で 2 度知らせない）。 */
  private readonly fromMissingNotified = new Set<string>();
  /** 問い合わせの取り込みが 1 通ごとに聞くため、会社ごとの窓口のアドレスを 5 分覚える。 */
  private readonly ownCache = new Map<string, { at: number; own: string[] }>();

  /** アプリの設定で選んだ差出人（無ければ窓口のアカウントの本来のアドレス。第33.24節）。 */
  private async fromOf(tenantId: string, appId: string, mailbox: Mailbox): Promise<string> {
    const app = await this.deps.apps.get(tenantId, appId);
    return (app?.settings.deliveries?.from ?? '').trim().toLowerCase() || mailbox.address;
  }

  /** 窓口のアカウントの本来のアドレスと送信元の別名（小文字）。読めなければ本来のアドレスだけ。 */
  private async ownAddresses(mailbox: Mailbox): Promise<string[]> {
    const sendAs = await mailbox.sendAs().catch(() => [] as string[]);
    return [...new Set([mailbox.address.toLowerCase(), ...sendAs.map((a) => a.toLowerCase())])];
  }

  constructor(private readonly deps: DeliveryDeps) {}

  // ---- 受ける ----

  /**
   * 配信の依頼を受ける（`POST /v1/deliveries`）。形・上限・窓口のアカウント・差し込みを確かめ、宛先を暗号化して置く。
   * 社内のアドレス 1 人だけへのテスト送信は承認を置かずに送る時を待ち、ほかは承認の業務を始める。
   *
   * @remarks 危険度: 受けるだけ（送るのは承認の後）。宛先はログに出さない
   */
  async accept(tenantId: string, appId: string, raw: unknown, now: Date = new Date()): Promise<DeliveryAcceptResult> {
    const bad = (code: DeliveryRejectCode, error: string, status: 400 | 404 | 409 | 422 = 400): DeliveryAcceptResult => ({ ok: false, status, code, error });
    const app = await this.deps.apps.get(tenantId, appId);
    const setting = app?.settings.deliveries;
    if (!app || !app.functions.includes('deliveries.send') || !setting) return bad('invalid', '「配信を頼む」が承認されていません', 404);
    const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    // テスト送信（`test: true`。職員の業務用のアドレスへの 1 通）は結果を持たない
    const testSend = b['test'] === true;
    const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : null);
    const requestId = str(b['requestId'], 100);
    const title = str(b['title'], 200)?.trim();
    if (!requestId || !/^[\x21-\x7e]+$/.test(requestId)) return bad('invalid', 'requestId（1〜100 文字の英数字と記号）を入れてください');
    if (!title) return bad('invalid', 'title（題名。200 文字まで）を入れてください');
    if (b['channel'] === 'line') return bad('channel-unsupported', 'LINE の配信はまだ受け付けていません（メールだけ）', 422);
    if (b['channel'] !== 'mail') return bad('invalid', 'channel は mail にしてください');
    const t = (b['template'] && typeof b['template'] === 'object' ? b['template'] : {}) as Record<string, unknown>;
    const subject = str(t['subject'], 300);
    const html = str(t['html'], 500_000);
    const text = str(t['text'], 200_000);
    if (!subject?.trim() || html === null || !text?.trim()) return bad('invalid', 'template の subject・html・text を入れてください（件名 300 文字・HTML 500 KB・本文 200 KB まで）');
    const valuesIn = b['values'] && typeof b['values'] === 'object' ? b['values'] as Record<string, unknown> : {};
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(valuesIn)) {
      if (!/^[A-Za-z0-9_]{1,50}$/.test(k) || typeof v !== 'string' || v.length > 2000) return bad('invalid', `values の「${k.slice(0, 50)}」の形が違います（英数字の名前と 2,000 文字までの文字）`);
      if (RESERVED.includes(k)) return bad('invalid', `values に「${k}」は入れられません（M2Office が差し込みます）`);
      values[k] = v;
    }
    if (Object.keys(values).length > 50) return bad('invalid', 'values は 50 個までです');
    let logo: DeliveryRecord['logo'] = null;
    if (b['logo'] !== null && b['logo'] !== undefined) {
      const l = b['logo'] as Record<string, unknown>;
      const ct = str(l['contentType'], 50);
      const cid = str(l['cid'], 100);
      const b64 = str(l['base64'], Math.ceil(DELIVERY_LOGO_MAX_BYTES * 1.4));
      if (!ct || !/^image\/(png|jpeg|gif)$/.test(ct) || !cid || !/^[A-Za-z0-9._@-]+$/.test(cid) || !b64 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) {
        return bad('invalid', `logo は contentType（image/png・jpeg・gif）・cid・base64（${DELIVERY_LOGO_MAX_BYTES / 1000} KB まで）で入れてください`);
      }
      if (Buffer.from(b64, 'base64').length > DELIVERY_LOGO_MAX_BYTES) return bad('invalid', `ロゴは ${DELIVERY_LOGO_MAX_BYTES / 1000} KB までです`);
      logo = { contentType: ct, base64: b64.replace(/\s+/g, ''), cid };
    }
    const sendAtRaw = b['sendAt'];
    let sendAt: string | null = null;
    if (sendAtRaw !== null && sendAtRaw !== undefined) {
      const d = typeof sendAtRaw === 'string' ? new Date(sendAtRaw) : null;
      if (!d || Number.isNaN(d.getTime())) return bad('invalid', 'sendAt は ISO 8601 の日時か null にしてください');
      sendAt = d.toISOString();
    }
    const list = Array.isArray(b['recipients']) ? b['recipients'] as unknown[] : [];
    const max = Math.min(setting.maxRecipients, DELIVERY_MAX_RECIPIENTS);
    if (list.length === 0) return bad('invalid', 'recipients（宛先）を 1 人以上入れてください');
    if (list.length > max) return bad('too-many', `1 回の依頼は ${max} 人までです（${list.length} 人）。分けて依頼してください`, 422);
    if (testSend && list.length !== 1) return bad('invalid', 'テスト送信（test: true）の宛先は 1 人にしてください');
    const seen = new Set<string>();
    const recipients: { recipientId: string; name: string; email: string }[] = [];
    for (const x of list) {
      const r = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
      const recipientId = str(r['recipientId'], 64);
      const name = str(r['name'], 200) ?? '';
      const email = (str(r['email'], 320) ?? '').trim();
      if (!recipientId || !RECIPIENT_ID.test(recipientId) || seen.has(recipientId)) {
        return bad('invalid', 'recipients の recipientId は、英数字と「-」「_」の 64 文字まで・重ならないものにしてください');
      }
      seen.add(recipientId);
      recipients.push({ recipientId, name, email });
    }
    // 差し込める名前だけか（知らない名前が残るなら受け付けない）
    const known = new Set([...RESERVED, ...Object.keys(values)]);
    const unknown = placeholdersOf(subject, html, text).filter((k) => !known.has(k));
    if (unknown.length) return bad('unknown-placeholder', `差し込めない名前があります: ${unknown.map((k) => `{{${k}}}`).join('・')}`, 422);
    const mailbox = await this.deps.mailbox(tenantId).catch(() => null);
    if (!mailbox) return bad('no-mailbox', '窓口のアカウントがつながっていないため送れません。管理者が問い合わせの記録の設定でつないでください', 409);

    const id = `dl-${randomUUID()}`;
    // 社内のアドレス 1 人だけへの送信は、承認を置かない（社内への送信。第9.4.0節）
    const tenant = await this.deps.repo.findTenantById(tenantId).catch(() => null);
    const domain = tenant?.workspaceDomain?.trim().toLowerCase() ?? '';
    const internalOne = recipients.length === 1 && !!domain && recipients[0]!.email.toLowerCase().endsWith(`@${domain}`);
    const at = now.toISOString();
    const rec: DeliveryRecord = {
      id, appId, requestId, title, channel: 'mail', status: internalOne ? 'scheduled' : 'awaiting_approval', sendAt, subject, html, text, values, logo,
      runId: null, total: recipients.length, test: testSend, createdAt: at, finishedAt: null, purgeAfter: null, purged: false,
    };
    const rows: RecipientRecord[] = recipients.map((r) => {
      const valid = EMAIL.test(r.email);
      // 形の違うアドレスは送らずに「送れなかった」とし、名前とアドレスを持たない
      return {
        deliveryId: id, recipientId: r.recipientId, contactEnc: valid ? this.deps.box.encrypt(JSON.stringify({ name: r.name, email: r.email })) : null,
        emailHash: valid ? emailHash(r.email) : null, hashUntil: null,
        status: valid ? 'pending' : 'failed', reason: valid ? null : 'invalid-address', stopChannel: null, at: valid ? null : at, nextSendAt: null, resultSeq: null,
      };
    });
    if (!(await this.deps.store.create(tenantId, rec, rows))) return bad('invalid', '同じ requestId の依頼をすでに受けています', 409);
    if (!internalOne) {
      try {
        const requestedBy = app.approvedBy ?? (await this.deps.repo.listUsers(tenantId)).find((u) => u.status === 'active' && u.roles.includes('admin'))?.id;
        if (!requestedBy || !this.deps.startApproval) throw new Error('承認する人がいません');
        const runId = await this.deps.startApproval(tenantId, id, requestedBy);
        await this.deps.store.update(tenantId, id, { runId });
      } catch (err) {
        // 始められなければ、受け付けなかったことにする（宛先を残さない）
        await this.deps.store.update(tenantId, id, { status: 'rejected', purgeAfter: at, finishedAt: at });
        await this.purge(tenantId, now);
        return bad('ai-unavailable', `承認の手続きを始められませんでした（${err instanceof Error ? err.message : String(err)}）`, 409);
      }
    }
    await this.audit(tenantId, `app:${appId}`, 'delivery.accept', id, { appId, requestId, title, recipients: recipients.length, test: testSend, approval: !internalOne });
    return { ok: true, deliveryId: id, status: rec.status };
  }

  // ---- 承認 ----

  /**
   * 承認の画面に出す中身（題名・道・差出人・人数・見本の宛先で差し込んだ件名と本文・送る日時）。**宛先の名前とアドレスの一覧は出さない**。
   */
  async preview(tenantId: string, id: string): Promise<{ shown: string; total: number } | { problem: string }> {
    const d = await this.deps.store.get(tenantId, id);
    if (!d) return { problem: '配信の依頼が見つかりません' };
    if (d.status !== 'awaiting_approval') return { problem: '承認を待っている配信ではありません' };
    const app = await this.deps.apps.get(tenantId, d.appId);
    const mailbox = await this.deps.mailbox(tenantId).catch(() => null);
    if (!mailbox) return { problem: '窓口のアカウントがつながっていないため送れません' };
    const counts = await this.deps.store.counts(tenantId, id);
    const from = await this.fromOf(tenantId, d.appId, mailbox);
    if (!(await this.ownAddresses(mailbox)).includes(from)) return { problem: `差出人 ${from} が窓口のアカウントの送信元にありません。Gmail の「他のメールアドレスを追加」で足してください` };
    const vars = { ...d.values, name: '（宛先の名前）', unsubscribe_url: unsubscribeAddress(from, 'xxxx'), unsubscribe_address: from };
    const shown = [
      `外部のアプリ「${app?.name ?? d.appId}」からの配信の依頼: ${d.title}`,
      `道: メール　差出人: ${from}`,
      `宛先: ${counts.pending} 人${counts.failed ? `（ほかにアドレスの形が違う ${counts.failed} 人は送りません）` : ''}`,
      `送る日時: ${d.sendAt ? new Date(d.sendAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '承認の後すぐ'}`,
      '',
      `件名: ${renderTemplate(d.subject, vars, false)}`,
      '',
      renderTemplate(d.text, vars, false),
    ].join('\n');
    return { shown, total: counts.pending };
  }

  /** 承認された配信を、送る時を待つ状態にする（承認の業務の「送る」の段が呼ぶ）。 */
  async approved(tenantId: string, userId: string, id: string): Promise<{ ok: true; total: number } | { error: string }> {
    const d = await this.deps.store.get(tenantId, id);
    if (!d) return { error: '配信の依頼が見つかりません' };
    if (d.status !== 'awaiting_approval') return { error: '承認を待っている配信ではありません' };
    await this.deps.store.update(tenantId, id, { status: 'scheduled' });
    await this.audit(tenantId, userId, 'delivery.approve', id, { appId: d.appId, requestId: d.requestId, recipients: d.total });
    return { ok: true, total: d.total };
  }

  // ---- 見回り（ワーカー） ----

  /**
   * 会社の配信を 1 回見回る: 却下された依頼を片付け、送る時が来た宛先に送り、消す時を過ぎたものを消す。
   *
   * @returns 送った数
   */
  async tick(tenantId: string, now: Date = new Date(), maxSends = 5): Promise<number> {
    const list = await this.deps.store.active(tenantId);
    let sent = 0;
    for (const d of list) {
      if (d.status === 'awaiting_approval') await this.syncApproval(tenantId, d, now);
      if (d.status === 'scheduled' && (!d.sendAt || d.sendAt <= now.toISOString())) {
        await this.deps.store.update(tenantId, d.id, { status: 'sending' });
        d.status = 'sending';
      }
      if (d.status === 'sending' && sent < maxSends) sent += await this.sendSome(tenantId, d, now, maxSends - sent);
    }
    await this.purge(tenantId, now);
    return sent;
  }

  private async purge(tenantId: string, now: Date): Promise<void> {
    await this.deps.store.purge(tenantId, now.toISOString(), new Date(now.getTime() - DELIVERY_KEEP_DAYS * DAY).toISOString());
  }

  /** 承認の業務が却下・取り消し・失敗で終わっていたら、まだ送っていない宛先を「却下」で送れなかったにする。 */
  private async syncApproval(tenantId: string, d: DeliveryRecord, now: Date): Promise<void> {
    if (!d.runId) return;
    const run = await this.deps.repo.getRun(tenantId, d.runId).catch(() => null);
    if (!run || !['cancelled', 'failed', 'expired'].includes(run.status)) return;
    await this.deps.store.failPending(tenantId, d.id, 'rejected', now.toISOString());
    await this.finish(tenantId, d, 'rejected', now);
    await this.audit(tenantId, 'system', 'delivery.reject', d.id, { appId: d.appId, requestId: d.requestId, run: run.status });
  }

  /** 配信を終わりにし、結果を消す時刻（30 日後）を決める。 */
  private async finish(tenantId: string, d: DeliveryRecord, status: 'done' | 'rejected', now: Date): Promise<void> {
    const finishedAt = now.toISOString();
    await this.deps.store.update(tenantId, d.id, { status, finishedAt, purgeAfter: new Date(now.getTime() + DELIVERY_KEEP_DAYS * DAY).toISOString() });
    d.status = status;
    d.finishedAt = finishedAt;
  }

  /** 窓口のアカウントから今送ってよい残りの数（過ぎた 24 時間で 1,000 通まで。Gmail に問い直すのは 10 分ごと）。 */
  private async quotaLeft(tenantId: string, mailbox: Mailbox, now: Date): Promise<number> {
    const q = this.quota.get(tenantId);
    if (q && q.pausedUntil > now.getTime()) return 0;
    if (q && now.getTime() - q.at < QUOTA_REFRESH_MS) return q.left;
    const used = await mailbox.countSent(new Date(now.getTime() - DAY)).catch(() => null);
    // 数えられなければ、慎重に今回は送らない
    const left = used === null ? 0 : Math.max(0, DELIVERY_DAILY_LIMIT - used);
    this.quota.set(tenantId, { left, at: now.getTime(), pausedUntil: 0 });
    return left;
  }

  /** 1 つの配信の、送る時が来た宛先に送る（1 通ごとに間を空ける）。送り終えたら終わりにする。 */
  private async sendSome(tenantId: string, d: DeliveryRecord, now: Date, max: number): Promise<number> {
    const mailbox = await this.deps.mailbox(tenantId).catch(() => null);
    if (!mailbox) return 0;
    // 選んだ差出人が送信元から外れていたら、送らずに止める（Gmail は確認の済んでいない From を本来のアドレスに替えて送ってしまう。第33.24節）
    const from = await this.fromOf(tenantId, d.appId, mailbox);
    if (!(await this.ownAddresses(mailbox)).includes(from)) {
      await this.fromMissing(tenantId, d, from, now);
      return 0;
    }
    this.fromMissingNotified.delete(d.id);
    let sent = 0;
    const hashUntil = new Date(now.getTime() + DELIVERY_HASH_KEEP_DAYS * DAY).toISOString();
    while (sent < max) {
      const last = this.lastSent.get(d.id) ?? 0;
      if (now.getTime() - last < DELIVERY_GAP_SECONDS * 1000 && sent > 0) break;
      if ((await this.quotaLeft(tenantId, mailbox, now)) <= 0) break;
      const r = await this.deps.store.nextRecipient(tenantId, d.id, now.toISOString());
      if (!r) break;
      if (!r.contactEnc) {
        await this.deps.store.setResult(tenantId, d.id, r.recipientId, { status: 'failed', reason: 'invalid-address', at: now.toISOString(), hashUntil: null });
        continue;
      }
      const contact = JSON.parse(this.deps.box.decrypt(r.contactEnc)) as { name: string; email: string };
      const unsubscribe = unsubscribeAddress(from, r.recipientId);
      const vars = { ...d.values, name: contact.name, unsubscribe_url: unsubscribe, unsubscribe_address: from };
      try {
        await mailbox.send({
          from, to: contact.email, subject: renderTemplate(d.subject, vars, false).replace(/[\r\n]+/g, ' '),
          body: renderTemplate(d.text, vars, false), html: d.html ? renderTemplate(d.html, vars, true) : null,
          ...(d.logo ? { inline: [{ cid: d.logo.cid, mime: d.logo.contentType, bytes: Buffer.from(d.logo.base64, 'base64') }] } : {}),
          // 送れなかった知らせに元の見出しが付いて返ってきたとき、宛先の ID で照らす
          headers: { 'X-M2O-Recipient': r.recipientId },
          listUnsubscribe: unsubscribe, inReplyTo: null, references: null, threadId: null,
        });
        // 送り終えたので名前とアドレスを消す。照合の値だけを 3 日持つ
        await this.deps.store.setResult(tenantId, d.id, r.recipientId, { status: 'sent', at: new Date().toISOString(), clearContact: true, hashUntil });
        const q = this.quota.get(tenantId);
        if (q) q.left -= 1;
        sent += 1;
        this.lastSent.set(d.id, now.getTime());
      } catch (err) {
        const status = err instanceof MailboxUnavailableError ? err.status : undefined;
        if (status === 400) {
          await this.deps.store.setResult(tenantId, d.id, r.recipientId, { status: 'failed', reason: 'invalid-address', at: now.toISOString(), clearContact: true, hashUntil: null });
          continue;
        }
        if (status === 429 || status === 403) {
          // Gmail の上限に当たった。1 時間待ってから続ける（送れなかったにはしない）
          const q = this.quota.get(tenantId) ?? { left: 0, at: now.getTime(), pausedUntil: 0 };
          this.quota.set(tenantId, { ...q, left: 0, pausedUntil: now.getTime() + HOUR });
          this.deps.logger?.warn('窓口のアカウントの送信の上限に当たったため、配信を 1 時間止めます', { tenantId, deliveryId: d.id, status });
          break;
        }
        // 届かないなど。5 分後に送り直す
        await this.deps.store.retryLater(tenantId, d.id, r.recipientId, new Date(now.getTime() + 5 * MIN).toISOString());
        this.deps.logger?.warn('配信の 1 通を送れませんでした。あとで送り直します', { tenantId, deliveryId: d.id, error: err instanceof Error ? err.message : String(err) });
        break;
      }
    }
    const c = await this.deps.store.counts(tenantId, d.id);
    if (c.pending === 0) {
      await this.finish(tenantId, d, 'done', now);
      await this.audit(tenantId, 'system', 'delivery.done', d.id, { appId: d.appId, requestId: d.requestId, sent: c.sent, failed: c.failed, stopped: c.stopped });
    }
    return sent;
  }

  // ---- 結果と停止を渡す（アプリが取りに来る） ----

  /**
   * 配信の結果（`GET /v1/deliveries/{requestId}/results`）。印より後の結果を 500 件まで渡す。
   * `done` は、送り終えて 24 時間たち（あとから届く送れなかった知らせを入れるため。却下は待たない）、渡していない結果が残っていないとき `true`。
   *
   * @remarks 危険度: 読むだけ。宛先の ID・状態・時刻だけを渡す。テスト送信は結果を持たない
   */
  async results(tenantId: string, appId: string, requestId: string, after: string | null, now: Date = new Date()): Promise<DeliveryResultsPage | { error: string; status: 400 | 404 }> {
    const from = cursorOf(after);
    if (from === null) return { error: 'after は前の答えの next をそのまま渡してください', status: 400 };
    const d = await this.deps.store.byRequest(tenantId, appId, requestId);
    if (!d) return { error: 'その requestId の配信はありません', status: 404 };
    const finished = d.status === 'done' || d.status === 'rejected';
    const settled = finished && (d.status === 'rejected' || d.test || (!!d.finishedAt && now.getTime() - Date.parse(d.finishedAt) >= DELIVERY_DONE_AFTER_HOURS * HOUR));
    if (d.test || d.purged) return { results: [], next: after || null, done: d.purged || settled };
    const rows = await this.deps.store.results(tenantId, d.id, from, DELIVERY_PAGE_SIZE + 1);
    const page = rows.slice(0, DELIVERY_PAGE_SIZE);
    const results: DeliveryResult[] = page.map((r) => ({
      recipientId: r.recipientId, status: r.status as DeliveryResult['status'], at: r.at ?? d.finishedAt ?? d.createdAt,
      ...(r.status === 'failed' && r.reason ? { reason: r.reason } : {}),
      ...(r.status === 'stopped' ? { channel: r.stopChannel ?? 'mail' } : {}),
    }));
    const last = page.at(-1)?.resultSeq;
    return { results, next: last !== undefined && last !== null ? String(last) : (after || null), done: settled && rows.length <= DELIVERY_PAGE_SIZE };
  }

  /**
   * 配信の停止（`GET /v1/deliveries/stops`）。そのアプリの配信で受けた停止を、印より後から 500 件まで渡す。
   *
   * @remarks 危険度: 読むだけ。宛先の ID が読めなかった停止だけ、差出人のアドレスを渡す
   */
  async stops(tenantId: string, appId: string, after: string | null): Promise<DeliveryStopsPage | { error: string }> {
    const from = cursorOf(after);
    if (from === null) return { error: 'after は前の答えの next をそのまま渡してください' };
    const rows = await this.deps.store.stops(tenantId, appId, from, DELIVERY_PAGE_SIZE);
    const stops = rows.map((s) => {
      if (s.recipientId) return { recipientId: s.recipientId, channel: s.channel, at: s.at };
      let email = '';
      try { email = s.emailEnc ? this.deps.box.decrypt(s.emailEnc) : ''; } catch { /* 読めなければ空 */ }
      return { email, channel: s.channel, at: s.at };
    });
    const last = rows.at(-1)?.seq;
    return { stops, next: last !== undefined ? String(last) : (after || null) };
  }

  // ---- 受信を読む ----

  /**
   * 窓口のアカウントのメールが、配信の停止の返信か送れなかった知らせか（問い合わせの記録に入れないため）。理由を返し、違えば `null`。
   */
  async mailKind(tenantId: string, m: MailItem, mailboxAddress: string, now: Date = new Date()): Promise<string | null> {
    const cached = this.ownCache.get(tenantId);
    let own = cached && now.getTime() - cached.at < 5 * MIN ? cached.own : null;
    if (!own) {
      const mailbox = await this.deps.mailbox(tenantId).catch(() => null);
      own = mailbox ? await this.ownAddresses(mailbox) : [mailboxAddress.toLowerCase()];
      this.ownCache.set(tenantId, { at: now.getTime(), own });
    }
    if (stopRecipientOf(m.to, own)) return '配信の停止の返信';
    if (isBounce(m.fromAddress, m.subject) && bouncedRecipientOf(m.body)) return '配信の送れなかった知らせ';
    // メールマガジンなど（配信の停止の案内を含む）は、停止の返信とみなさない
    if (!m.bulk && isStopReply(m.subject, m.body)) {
      const apps = await this.deps.store.recentApps(tenantId, new Date(now.getTime() - DELIVERY_KEEP_DAYS * DAY).toISOString()).catch(() => []);
      if (apps.length) return '配信の停止の返信';
    }
    return null;
  }

  /**
   * 窓口のアカウントの受信を読み、配信の停止の返信と送れなかった知らせを見つける。
   *
   * 停止: 宛先の `+stop-<ID>` があればその ID の停止（本文は問わない）。無ければ、件名か本文の初めが停止の言葉の返信を、
   * 差出人のアドレスの照合の値で探し、見つからなければ差出人のアドレスの停止として、その会社で配信を頼んだアプリに渡す。
   * 送れなかった知らせ: 元の見出しの `X-M2O-Recipient` か、照合の値で宛先を探す。
   *
   * @remarks 返信の中身は残さない
   * @returns 見つけた数
   */
  async readMail(tenantId: string, now: Date = new Date()): Promise<number> {
    const active = await this.deps.store.active(tenantId);
    if (active.length === 0) return 0;
    const mailbox = await this.deps.mailbox(tenantId).catch(() => null);
    if (!mailbox) return 0;
    const cursor = await this.deps.store.mailCursor(tenantId);
    const since = new Date(Math.max(Date.parse(cursor ?? active[0]!.createdAt) - 10 * MIN, now.getTime() - DELIVERY_KEEP_DAYS * DAY));
    const ids = await mailbox.list('inbox', since, 100).catch(() => [] as string[]);
    const own = await this.ownAddresses(mailbox);
    let found = 0;
    for (const mid of ids) {
      const m = await mailbox.get(mid).catch(() => null);
      if (!m || own.includes(m.fromAddress.toLowerCase())) continue;
      const at = m.date;
      if (isBounce(m.fromAddress, m.subject)) {
        const rid = bouncedRecipientOf(m.body);
        const targets = rid ? await this.deps.store.findRecipient(tenantId, rid) : await this.byAddressesIn(tenantId, m.body, own, now);
        for (const r of targets) {
          if (r.status !== 'sent') continue;
          await this.deps.store.setResult(tenantId, r.deliveryId, r.recipientId, { status: 'failed', reason: 'bounced', at });
          found++;
        }
        continue;
      }
      const rid = stopRecipientOf(m.to, own);
      if (rid) {
        for (const r of await this.deps.store.findRecipient(tenantId, rid)) found += await this.stop(tenantId, r, m.id, at);
        continue;
      }
      // メールマガジンなど（配信の停止の案内を含む）は、停止の返信とみなさない
      if (m.bulk || !isStopReply(m.subject, m.body)) continue;
      const matched = await this.deps.store.findByHash(tenantId, emailHash(m.fromAddress), now.toISOString());
      if (matched.length) {
        for (const r of matched) found += await this.stop(tenantId, r, m.id, at);
        continue;
      }
      // 宛先の ID が読めない返信は、差出人のアドレスで渡す（アプリが連絡先から探す）
      for (const appId of await this.deps.store.recentApps(tenantId, new Date(now.getTime() - DELIVERY_KEEP_DAYS * DAY).toISOString())) {
        if (await this.deps.store.addStop(tenantId, {
          appId, deliveryId: null, recipientId: null, emailEnc: this.deps.box.encrypt(m.fromAddress), channel: 'mail', at, source: `${m.id}:email`,
        })) found++;
      }
    }
    await this.deps.store.setMailCursor(tenantId, now.toISOString());
    return found;
  }

  /** 送れなかった知らせの本文に出てくるアドレスのうち、照合の値に当たる宛先。 */
  private async byAddressesIn(tenantId: string, body: string, own: string[], now: Date) {
    const out: Awaited<ReturnType<DeliveryStore['findByHash']>> = [];
    for (const addr of new Set((body.match(/[^\s<>()"',;:]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).map((x) => x.toLowerCase()))) {
      if (own.includes(addr)) continue;
      out.push(...await this.deps.store.findByHash(tenantId, emailHash(addr), now.toISOString()));
    }
    return out;
  }

  /** 宛先 1 人の停止を入れ、結果も「停止」にする。入れたら 1。 */
  private async stop(tenantId: string, r: RecipientRecord & { appId: string }, messageId: string, at: string): Promise<number> {
    const added = await this.deps.store.addStop(tenantId, {
      appId: r.appId, deliveryId: r.deliveryId, recipientId: r.recipientId, emailEnc: null, channel: 'mail', at, source: `${messageId}:${r.recipientId}`,
    });
    if (added && r.status !== 'stopped' && r.status !== 'pending') {
      await this.deps.store.setResult(tenantId, r.deliveryId, r.recipientId, { status: 'stopped', stopChannel: 'mail', at });
    }
    return added ? 1 : 0;
  }

  /** 差出人が送信元から外れて止めたことを、管理者に 1 度だけ知らせる（送信元に戻されたら続ける）。 */
  private async fromMissing(tenantId: string, d: DeliveryRecord, from: string, now: Date): Promise<void> {
    if (this.fromMissingNotified.has(d.id)) return;
    this.fromMissingNotified.add(d.id);
    for (const u of await this.deps.repo.listUsers(tenantId)) {
      if (u.status !== 'active' || !u.roles.includes('admin')) continue;
      await this.deps.repo.createNotification({
        id: randomUUID(), tenantId, userId: u.id, kind: 'failure', title: `配信を止めています: ${d.title}`,
        body: `差出人 ${from} が、窓口のアカウントの送信元にありません。送らずに止めています。窓口のアカウントの Gmail の「設定 → アカウント →「他のメールアドレスを追加」」で ${from} を足すと、続けて送ります。`.slice(0, 400),
        runId: null, readAt: null, createdAt: now.toISOString(),
      });
    }
    await this.audit(tenantId, 'system', 'delivery.from_missing', d.id, { appId: d.appId, requestId: d.requestId });
    this.deps.logger?.warn('配信の差出人が窓口のアカウントの送信元に無いため止めています', { tenantId, deliveryId: d.id });
  }

  // ---- 管理者に見せる ----

  /** 配信の一覧（宛先は出さない。人数と結果の数だけ）。 */
  async list(tenantId: string, appId?: string): Promise<DeliveryView[]> {
    const rows = await this.deps.store.list(tenantId, { ...(appId ? { appId } : {}), limit: 50 });
    return Promise.all(rows.map(async (d) => {
      const c = d.purged ? null : await this.deps.store.counts(tenantId, d.id);
      return {
        id: d.id, appId: d.appId, requestId: d.requestId, title: d.title, channel: d.channel, status: d.status, total: d.total,
        sent: c?.sent ?? 0, failed: c?.failed ?? 0, stopped: c?.stopped ?? 0, sendAt: d.sendAt, createdAt: d.createdAt, finishedAt: d.finishedAt, test: d.test,
      };
    }));
  }

  private async audit(tenantId: string, actor: string, action: string, id: string, detail: Record<string, unknown>): Promise<void> {
    await this.deps.repo.appendAudit({
      id: randomUUID(), tenantId, actorType: actor === 'system' ? 'system' : 'user', actorId: actor, action, targetType: 'delivery', targetId: id, detail,
      occurredAt: new Date().toISOString(),
    });
  }
}

export type { DeliveryFailReason };
