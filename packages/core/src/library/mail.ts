/**
 * @file 資料のメールの添付の取り込み（仕様書 第44.4節。段 2）。
 *
 * - 本人が「資料」の画面で 1 度オンにすると、受け取ったメールの添付を自動で資料に集める。切ればすぐ止まる。管理者や会社の設定では入れられない
 * - 権限は `gmail.readonly` のまま増やさない。ごみ箱・迷惑メール・送ったメールは見ない
 * - 新しいメールは 15 分ごとに見る。過去のメールは直近 1 年を新しい順に、1 人 1 日 500 通まで裏で進める。後から本人が 1 年ずつ広げられる
 * - 本文に埋め込まれた画像・小さい画像・予定の招待・配信のメールの添付は、推論を呼ばずに決まりで除く
 * - 中身が同じファイルは 1 つにまとめ、届いたメールをすべて手がかりに残す。削除した資料は取り込み直さない
 * - メールの本文は読まない・持たない（Q-310）。メールの文は指示として扱わない（不変則 I-6）
 * - 第42.13.1節の注文書の取り込みとは別に動き、互いに影響しない
 *
 * @see 仕様書 第44.4節・第44.9節・第44.11節
 * @see ADR-0125
 */

import { randomUUID } from 'node:crypto';
import { LIBRARY_LIMITS, LIBRARY_MAIL_LIMITS, isRefusedLibraryName, type LibraryMailState } from '@m2office/shared';
import { ConnectorUnavailableError, type MailAttachmentPart, type MailConnector } from '../connectors/types.js';
import type { Logger } from '../log/logger.js';
import type { Repository } from '../repository/types.js';
import type { LibraryService } from './service.js';
import type { LibraryMailWatchRow, LibraryStore, LibraryViewer } from './store.js';

/** 取り込まない理由（第44.4節「除くもの」）。 */
export type LibraryMailSkip = 'embedded' | 'calendar' | 'small_image' | 'refused';

/** 予定の招待の形。 */
const CALENDAR_MIME = /^(text\/calendar|application\/ics)$/i;

/**
 * 添付を取り込まない理由。取り込むなら `null`（第44.4節）。推論は呼ばず、決まりだけで決める。
 *
 * @param part 添付の様子（中身は読まない）
 */
export function libraryMailSkipOf(part: Pick<MailAttachmentPart, 'name' | 'mime' | 'size' | 'embedded'>): LibraryMailSkip | null {
  const image = /^image\//i.test(part.mime);
  if (part.embedded && image) return 'embedded';
  if (CALENDAR_MIME.test(part.mime) || /\.(ics|vcs)$/i.test(part.name)) return 'calendar';
  if (image && part.size > 0 && part.size < LIBRARY_MAIL_LIMITS.smallImageBytes) return 'small_image';
  if (isRefusedLibraryName(part.name)) return 'refused';
  return null;
}

/** メールの添付の取り込みに渡すもの。 */
export interface LibraryMailDeps {
  service: LibraryService;
  store: LibraryStore;
  mail: MailConnector;
  repo: Pick<Repository, 'appendAudit'>;
  /** 会社が資料を使っていて、本人が利用範囲の中か。 */
  access(tenantId: string, userId: string): Promise<unknown>;
  logger: Logger;
  now?(): Date;
}

/** 日本時間の日付（`YYYY-MM-DD`）。 */
const jstDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/** 何年か前の同じ時刻。 */
const yearsBefore = (iso: string, years: number) => {
  const d = new Date(iso);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString();
};

/** 秒の UNIX 時刻。 */
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** 一度もオンにしていない人の様子。 */
const OFF: LibraryMailState = { enabled: false, checkedAt: null, backFrom: null, backUntil: null, backDone: false, scanned: 0, imported: 0, error: '' };

/** Gmail を読めない（許可が無い・届かない）か。読めなければ止めて、理由を本人に示す。 */
const isConnector = (err: unknown): err is ConnectorUnavailableError => err instanceof ConnectorUnavailableError;

/**
 * メールの添付の取り込み（第44.4節）。ワーカー（見本の会社は API）が {@link LibraryMailWatch.tick} を呼ぶ。
 */
export class LibraryMailWatch {
  constructor(private readonly deps: LibraryMailDeps) {}

  private now() { return this.deps.now?.() ?? new Date(); }

  /** 操作の記録。送り主・件名・中身は残さない（第44.10節）。 */
  private async audit(who: LibraryViewer, action: string, detail: Record<string, unknown> = {}) {
    await this.deps.repo.appendAudit({
      id: randomUUID(), tenantId: who.tenantId, actorType: 'user', actorId: who.userId, action, targetType: 'library_mail', targetId: who.userId, detail, occurredAt: this.now().toISOString(),
    });
  }

  /** 本人の取り込みの様子。 */
  async state(who: LibraryViewer): Promise<LibraryMailState> {
    const w = await this.deps.store.mailWatch(who);
    if (!w) return OFF;
    return { enabled: w.enabled, checkedAt: w.checkedAt, backFrom: w.backFrom, backUntil: w.backUntil, backDone: w.backDone, scanned: w.scanned, imported: w.imported, error: w.error };
  }

  /**
   * 本人が取り込みを入れる・切る（第44.4節）。初めて入れたときは、直近 1 年を過去の分として見始める。
   *
   * @remarks 危険度: 本人の受信箱を読むだけ（`gmail.readonly`）。切っていた間に届いたメールは集めない（入れ直した後に届いたものから集める）
   */
  async setEnabled(who: LibraryViewer, enabled: boolean): Promise<LibraryMailState> {
    const cur = await this.deps.store.mailWatch(who);
    const now = this.now().toISOString();
    if (enabled) {
      const next: LibraryMailWatchRow = cur
        ? { ...cur, enabled: true, checkedAt: now, error: '' }
        : {
          enabled: true, checkedAt: now, backFrom: yearsBefore(now, LIBRARY_MAIL_LIMITS.backfillYears), backUntil: now, backToken: null, backDone: false,
          backDay: null, backCount: 0, scanned: 0, imported: 0, error: '',
        };
      await this.deps.store.saveMailWatch(who, next);
      if (!cur?.enabled) await this.audit(who, 'library.mail.on');
    } else if (cur?.enabled) {
      await this.deps.store.saveMailWatch(who, { ...cur, enabled: false });
      await this.audit(who, 'library.mail.off');
    }
    return this.state(who);
  }

  /**
   * 過去のメールを見る範囲を、さらに 1 年さかのぼる（第44.4節「後から本人が広げられる」）。いまの範囲を見終えた後だけ。
   */
  async extend(who: LibraryViewer): Promise<LibraryMailState | { refused: string }> {
    const cur = await this.deps.store.mailWatch(who);
    if (!cur?.enabled || !cur.backFrom) return { refused: 'メールの添付の取り込みが入っていません' };
    if (!cur.backDone) return { refused: 'いまの範囲のメールを見ている途中です' };
    await this.deps.store.saveMailWatch(who, {
      ...cur, backUntil: cur.backFrom, backFrom: yearsBefore(cur.backFrom, LIBRARY_MAIL_LIMITS.backfillYears), backToken: null, backDone: false,
    });
    await this.audit(who, 'library.mail.extend');
    return this.state(who);
  }

  /**
   * 入れる前・広げる前の、添付のあるメールのおおよその数と、読む費用の目安（第44.11節）。
   *
   * @param which `start` は直近 1 年、`extend` はいまの範囲のさらに 1 年前
   * @returns `confirm` が真なら、件数が多いので費用を確かめてから入れる（お金に関わるため。ADR-0028）
   */
  async estimate(who: LibraryViewer, which: 'start' | 'extend'): Promise<{ messages: number | null; costJpy: number | null; confirm: boolean }> {
    const cur = await this.deps.store.mailWatch(who);
    const now = this.now().toISOString();
    const until = which === 'extend' && cur?.backFrom ? cur.backFrom : now;
    const from = yearsBefore(until, LIBRARY_MAIL_LIMITS.backfillYears);
    const messages = await this.deps.mail.attachmentCount?.(who, { after: sec(from), before: sec(until) }).catch(() => null) ?? null;
    const costJpy = messages === null ? null : await this.deps.service.estimate(who.tenantId, messages);
    return { messages, costJpy, confirm: messages !== null && messages > LIBRARY_LIMITS.confirmCount && costJpy !== null };
  }

  /**
   * 見回り 1 回分。会社ごとに、取り込みを入れている人の受信箱を見る。
   *
   * @param tenantIds 資料を使っている会社
   * @returns 資料に入れた件数
   */
  async tick(tenantIds: string[]): Promise<number> {
    let n = 0;
    for (const tenantId of tenantIds) {
      for (const userId of await this.deps.store.mailWatchers(tenantId)) {
        n += await this.runFor({ tenantId, userId }).catch((err: unknown) => {
          this.deps.logger.warn('メールの添付を資料に入れられませんでした', { tenantId, err: err instanceof Error ? err.name : 'unknown' });
          return 0;
        });
      }
    }
    return n;
  }

  /**
   * 1 人分。新しいメール（15 分ごと）と、過去のメールの続き（1 日 500 通まで）を見る。
   *
   * @returns 資料に入れた件数
   */
  async runFor(who: LibraryViewer): Promise<number> {
    const w = await this.deps.store.mailWatch(who);
    if (!w?.enabled) return 0;
    // 会社が資料を切った・利用範囲から外れた人は見ない（入り切りは残す）
    if (!(await this.deps.access(who.tenantId, who.userId))) return 0;
    const now = this.now();
    const counts = { scanned: 0, imported: 0 };
    try {
      if (!w.checkedAt || now.getTime() - Date.parse(w.checkedAt) >= LIBRARY_MAIL_LIMITS.newMailMinutes * 60_000) {
        const after = w.checkedAt ? sec(w.checkedAt) - 60 : sec(now.toISOString()) - 60;
        await this.newMail(who, after, counts);
        w.checkedAt = now.toISOString();
      }
      if (!w.backDone && w.backFrom && w.backUntil) await this.backfill(who, w, now, counts);
      w.error = '';
    } catch (err) {
      if (!isConnector(err)) throw err;
      w.error = err.message;
    }
    w.scanned += counts.scanned;
    w.imported += counts.imported;
    // 見ている間に本人が切っていたら、切ったままにする
    const latest = await this.deps.store.mailWatch(who);
    await this.deps.store.saveMailWatch(who, { ...w, enabled: latest?.enabled ?? w.enabled });
    return counts.imported;
  }

  /** 新しいメール。見落としが無いよう、前に見た時刻の少し前から見る（同じメールは読み直さない）。 */
  private async newMail(who: LibraryViewer, after: number, counts: { scanned: number; imported: number }) {
    const mail = this.deps.mail;
    if (!mail.attachmentPage) return;
    let token: string | undefined;
    let seen = 0;
    do {
      const page = await mail.attachmentPage(who, { after, ...(token ? { pageToken: token } : {}), limit: 50 });
      for (const id of page.ids) {
        if (seen >= LIBRARY_MAIL_LIMITS.newMailMax) return;
        seen += 1;
        await this.message(who, id, counts);
      }
      token = page.next ?? undefined;
    } while (token && seen < LIBRARY_MAIL_LIMITS.newMailMax);
  }

  /** 過去のメールの続き。新しい順に、1 日の通数まで進める。 */
  private async backfill(who: LibraryViewer, w: LibraryMailWatchRow, now: Date, counts: { scanned: number; imported: number }) {
    const mail = this.deps.mail;
    if (!mail.attachmentPage) return;
    const day = jstDay(now);
    if (w.backDay !== day) { w.backDay = day; w.backCount = 0; }
    const room = Math.min(LIBRARY_MAIL_LIMITS.backfillBatch, LIBRARY_MAIL_LIMITS.backfillPerDay - w.backCount);
    if (room <= 0) return;
    let page: { ids: string[]; next: string | null };
    try {
      page = await mail.attachmentPage(who, { after: sec(w.backFrom!), before: sec(w.backUntil!), ...(w.backToken ? { pageToken: w.backToken } : {}), limit: room });
    } catch (err) {
      // 続きの印が古くなった。次の回に範囲の初めから見直す（見たメールは読み直さない）
      if (w.backToken && !isConnector(err)) { w.backToken = null; return; }
      throw err;
    }
    for (const id of page.ids) await this.message(who, id, counts);
    w.backCount += page.ids.length;
    w.backToken = page.next;
    if (!page.next) { w.backDone = true; w.backToken = null; }
  }

  /** 1 通を見る。資料に入れた件数を足す。 */
  private async message(who: LibraryViewer, id: string, counts: { scanned: number; imported: number }) {
    counts.scanned += 1;
    if (await this.deps.store.seenMessage(who, id)) return;
    const mail = this.deps.mail;
    const list = await mail.attachmentParts?.(who, id);
    // 配信のメールの添付は入れない（第44.4節）
    if (!list || list.bulk) return;
    const parts = list.parts.filter((p) => libraryMailSkipOf(p) === null).slice(0, LIBRARY_MAIL_LIMITS.partsPerMessage);
    for (const part of parts) {
      try {
        const bytes = part.size > LIBRARY_LIMITS.placeBytes ? null : await mail.attachmentBytes?.(who, id, part.attachmentId) ?? null;
        if (bytes === null && part.size <= LIBRARY_LIMITS.placeBytes) continue;
        const r = await this.deps.service.importMailAttachment(who, {
          name: part.name, bytes, size: bytes?.length ?? part.size, messageId: id, sender: list.from, subject: list.subject, receivedAt: list.receivedAt,
        });
        if ('item' in r && r.created) counts.imported += 1;
      } catch (err) {
        if (isConnector(err)) throw err;
        this.deps.logger.warn('メールの添付を 1 つ入れられませんでした', { tenantId: who.tenantId, err: err instanceof Error ? err.name : 'unknown' });
      }
    }
  }
}
