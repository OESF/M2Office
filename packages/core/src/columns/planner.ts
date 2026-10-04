/**
 * @file コラムの作成の段 2 の処理（仕様書 第32.6節・第32.10節・第32.11節・第32.18.4節）。テーマ案・予定表と先回り・予約から入れる・
 * 貼るだけのページ。ワーカーの見回り（{@link ColumnPlanner.tick}）が、週に 1 回のテーマ案・7 日前の先回り・飛ばす回・予約を行う。
 *
 * 人に判断を求めるのは公開の承認だけ（ADR-0028）。テーマ案から書き始めるのも、予定表の回に入れるのも AI が行い、知らせる。
 * 承認されないまま公開の日時を過ぎた回は飛ばす（勝手に公開しない）。
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  COLUMN_PREPARE_DAYS, COLUMN_THEMES_PER_WEEK,
  type ColumnPlanSlot, type WebColumn, type WebColumnTheme,
} from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { LlmProvider } from '../llm/provider.js';
import { silentLogger, type Logger } from '../log/logger.js';
import type { ColumnService, ColumnViewer } from './service.js';
import { finalMarkdown } from './service.js';
import type { ColumnStore } from './store.js';
import { columnHtml } from './wordpress.js';
import { monthSlots, slotTime, writeThemes } from './plan.js';

/** ほかの拡張から来るテーマ案の材料（使っていなければ空）。 */
export interface ColumnThemeMaterials {
  /** 検索の言葉（Web の振り返りの合う記事が無い言葉と伸びた言葉） */
  searchWords?(tenantId: string): Promise<string[]>;
  /** 競合の話題（競合の分析のいちばん新しいレポートのコラムの話題） */
  competitorThemes?(tenantId: string): Promise<string[]>;
  /** よく来る質問の話題（問い合わせの記録。誰からかは渡さない） */
  questions?(tenantId: string): Promise<string[]>;
  /** 書き直しの案（Web の振り返りの直すべき所のうちコラムのもの） */
  rewrites?(tenantId: string): Promise<{ columnId: string; theme: string; why: string }[]>;
}

/** 処理に要るもの。 */
export interface ColumnPlannerDeps {
  service: ColumnService;
  store: ColumnStore;
  repo: Repository;
  llmFor(tenantId: string): Promise<LlmProvider | null>;
  materials?: ColumnThemeMaterials;
  logger?: Logger;
}

/** 仕組みが行うとき（ワーカー）の操作する人。 */
const SYSTEM = 'system';

/** 貼るだけのページの 1 本（ログインの無い人に見せる）。 */
export interface PastePageColumn {
  id: string;
  title: string;
  description: string;
  html: string;
  date: string;
  hasCover: boolean;
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const jstToday = (now: Date) => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
const md = (d: string) => `${Number(d.slice(5, 7))} 月 ${Number(d.slice(8, 10))} 日`;

/**
 * コラムの作成の段 2 の操作。
 *
 * @remarks 呼ぶ前に、利用者がコラムの作成を使えるかを確かめること。貼るだけのページの入り切りは管理者だけ（呼び出し側で確かめる）
 */
export class ColumnPlanner {
  private readonly log: Logger;

  constructor(private readonly deps: ColumnPlannerDeps) {
    this.log = deps.logger ?? silentLogger;
  }

  private async audit(tenantId: string, userId: string, action: string, targetId: string, detail: Record<string, unknown>): Promise<void> {
    await this.deps.repo.appendAudit({
      id: randomUUID(), tenantId, actorType: userId === SYSTEM ? 'system' : 'user', actorId: userId === SYSTEM ? 'column-watch' : userId,
      action, targetType: 'web_column', targetId, detail, occurredAt: new Date().toISOString(),
    });
  }

  /** 知らせる人（管理者・承認者と、この 90 日にコラムを書いた人）。 */
  private async recipients(tenantId: string): Promise<string[]> {
    const users = (await this.deps.repo.listUsers(tenantId)).filter((u) => u.status === 'active');
    const since = Date.now() - 90 * 86_400_000;
    const writers = new Set((await this.deps.store.list(tenantId)).filter((c) => Date.parse(c.createdAt) >= since && c.createdBy !== SYSTEM).map((c) => c.createdBy));
    return users.filter((u) => u.roles.includes('admin') || u.roles.includes('approver') || writers.has(u.id)).map((u) => u.id);
  }

  private async notify(tenantId: string, userIds: string[], title: string, body: string): Promise<void> {
    for (const userId of [...new Set(userIds)]) {
      const prefs = await this.deps.repo.getUserSettings(tenantId, userId).catch(() => null);
      if (prefs?.notifications.kinds.column === false) continue;
      await this.deps.repo.createNotification({
        id: randomUUID(), tenantId, userId, kind: 'column', title, body: body.slice(0, 300), runId: null, readAt: null, createdAt: new Date().toISOString(),
      }).catch((err: unknown) => this.log.warn('コラムの作成の知らせを作れませんでした', { error: String(err) }));
    }
  }

  // ---- テーマ案（第32.6節） ---------------------------------------------------------------------

  /** まだ使っていないテーマ案（新しい順）。 */
  async themes(tenantId: string): Promise<WebColumnTheme[]> {
    return this.deps.store.themes(tenantId, ['new']);
  }

  /**
   * テーマ案を作る（週に 1 回・画面の「テーマ案を出す」・秘書）。書き直しの案も足す。分野が無ければ作らない。
   *
   * @returns 足した案。作れなければ理由
   */
  async generateThemes(tenantId: string, userId: string, now: Date = new Date(), notify = true): Promise<{ added: WebColumnTheme[] } | { error: string }> {
    const settings = await this.deps.repo.getTenantSettings(tenantId);
    const w = settings.webColumns;
    if (!w.topics.length) return { error: '拡張機能の設定で、書きたい分野を入れると、テーマ案を出します' };
    const m = this.deps.materials;
    const [searchWords, competitorThemes, questions, rewrites, columns, pending] = await Promise.all([
      m?.searchWords?.(tenantId).catch(() => []) ?? [], m?.competitorThemes?.(tenantId).catch(() => []) ?? [],
      m?.questions?.(tenantId).catch(() => []) ?? [], m?.rewrites?.(tenantId).catch(() => []) ?? [],
      this.deps.store.list(tenantId), this.deps.store.themes(tenantId, ['new', 'dismissed'], 200),
    ]);
    const existing = [...columns.flatMap((c) => [c.theme, c.title]), ...pending.map((t) => t.theme)].filter(Boolean);
    const llm = await this.deps.llmFor(tenantId).catch(() => null);
    const ideas = await writeThemes(llm, { topics: w.topics, audience: w.audience, today: jstToday(now), searchWords, competitorThemes, questions, existing }, COLUMN_THEMES_PER_WEEK);
    const ids: string[] = [];
    for (const t of ideas) ids.push(await this.deps.store.addTheme(tenantId, { ...t, columnId: null }));
    // 書き直しの案（同じコラムの案がまだあれば足さない）
    const rewriting = new Set(pending.filter((t) => t.status === 'new' && t.columnId).map((t) => t.columnId));
    for (const r of rewrites.filter((x) => !rewriting.has(x.columnId)).slice(0, 3)) {
      ids.push(await this.deps.store.addTheme(tenantId, { theme: r.theme, why: r.why, source: 'rewrite', columnId: r.columnId }));
    }
    await this.deps.repo.saveTenantSettings(tenantId, 'webColumns', { ...w, themesAt: now.toISOString() }, userId);
    await this.audit(tenantId, userId, 'column.themes', 'themes', { count: ids.length });
    const added = (await this.deps.store.themes(tenantId, ['new'], 100)).filter((t) => ids.includes(t.id));
    if (notify && added.length) await this.notify(tenantId, await this.recipients(tenantId), `コラムのテーマ案が ${added.length} つあります`, added.slice(0, 3).map((t) => t.theme).join('・'));
    return { added };
  }

  /**
   * テーマ案から書き始める（書き直しの案なら、案の文を指示にして書き直す）。案は使ったにする。
   *
   * @returns 書き始めたコラム。書けなければ理由
   */
  async writeFromTheme(who: ColumnViewer, themeId: string, slot?: string): Promise<{ columnId: string } | { error: string }> {
    const t = (await this.deps.store.themes(who.tenantId, ['new'], 200)).find((x) => x.id === themeId);
    if (!t) return { error: 'テーマ案が見つかりません' };
    let columnId: string;
    if (t.columnId) {
      const err = await this.deps.service.rewrite(who, t.columnId, t.why || t.theme);
      if (err) return { error: err };
      columnId = t.columnId;
    } else {
      const r = await this.deps.service.create(who, { theme: t.theme, memo: t.why });
      if ('error' in r) return r;
      columnId = r.id;
      if (slot) await this.deps.store.update(who.tenantId, columnId, { plannedFor: slot, publishAt: slotTime(slot) });
    }
    await this.deps.store.setThemeStatus(who.tenantId, t.id, 'used');
    await this.audit(who.tenantId, who.userId, 'column.theme_use', columnId, { source: t.source, ...(slot ? { slot } : {}) });
    return { columnId };
  }

  /** テーマ案を見送りにする。 */
  async dismissTheme(who: ColumnViewer, themeId: string): Promise<string | null> {
    const t = (await this.deps.store.themes(who.tenantId, ['new'], 200)).find((x) => x.id === themeId);
    if (!t) return 'テーマ案が見つかりません';
    await this.deps.store.setThemeStatus(who.tenantId, t.id, 'dismissed');
    await this.audit(who.tenantId, who.userId, 'column.theme_dismiss', t.id, { source: t.source });
    return null;
  }

  /**
   * 上から N 本のテーマ案で書き始める（秘書の「来月の分を 4 本用意して」）。予定表があれば、空いている回に入れる。
   */
  async prepare(who: ColumnViewer, count: number, now: Date = new Date()): Promise<{ columnIds: string[] } | { error: string }> {
    const n = Math.max(1, Math.min(8, Math.floor(count) || 1));
    let pool = await this.themes(who.tenantId);
    if (pool.filter((t) => !t.columnId).length < n) {
      const g = await this.generateThemes(who.tenantId, who.userId, now, false);
      if ('error' in g && !pool.length) return g;
      pool = await this.themes(who.tenantId);
    }
    const free = (await this.plan(who.tenantId, now)).filter((s) => !s.columnId && s.date > jstToday(now)).map((s) => s.date);
    const ids: string[] = [];
    for (const t of pool.filter((x) => !x.columnId).slice(0, n)) {
      const r = await this.writeFromTheme(who, t.id, free.shift());
      if ('columnId' in r) ids.push(r.columnId);
    }
    return ids.length ? { columnIds: ids } : { error: '書き始められるテーマ案がありません' };
  }

  // ---- 予定表と先回り（第32.11節） ---------------------------------------------------------------

  /** 今月と来月の回（入れたコラムつき）。予定表が無ければ空。 */
  async plan(tenantId: string, now: Date = new Date()): Promise<ColumnPlanSlot[]> {
    const plan = (await this.deps.repo.getTenantSettings(tenantId)).webColumns.plan;
    if (!plan) return [];
    const month = jstToday(now).slice(0, 7);
    const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 7);
    const columns = await this.deps.store.list(tenantId);
    return [...monthSlots(plan, month), ...monthSlots(plan, next)].map((date) => {
      const c = columns.find((x) => x.plannedFor === date && x.status !== 'withdrawn');
      return { date, columnId: c?.id ?? null, title: c ? c.title || c.theme : '', status: c?.status ?? null };
    });
  }

  /** 先回りに使う人（作った人の記録。仕組みが書く）。 */
  private system(tenantId: string): ColumnViewer {
    return { tenantId, userId: SYSTEM };
  }

  /**
   * 1 回分の見回り（ワーカー）。会社ごとに、週に 1 回のテーマ案・7 日前の先回り・飛ばす回・予約から入れるを行う。
   */
  async tick(now: Date = new Date()): Promise<{ themes: number; prepared: number; skipped: number; placed: number }> {
    const out = { themes: 0, prepared: 0, skipped: 0, placed: 0 };
    const jst = new Date(now.getTime() + 9 * 3_600_000);
    const today = jstToday(now);
    for (const tenantId of await this.deps.repo.listTenantIds()) {
      try {
        const w = (await this.deps.repo.getTenantSettings(tenantId)).webColumns;
        if (!w.enabled) continue;
        // 予約から入れる（公開の日時を過ぎたもの）
        for (const id of await this.deps.store.dueScheduled(tenantId, now.toISOString())) {
          const c = await this.deps.store.get(tenantId, id);
          const r = await this.deps.service.placeScheduled(this.system(tenantId), id);
          const title = c?.title || c?.theme || 'コラム';
          const to = c && c.createdBy !== SYSTEM ? [c.createdBy] : await this.recipients(tenantId);
          if ('error' in r) await this.notify(tenantId, to, `予約のコラム「${title}」を入れられませんでした`, r.error);
          else {
            out.placed += 1;
            await this.notify(tenantId, to, r.placed ? `予約のコラム「${title}」を WordPress に下書きとして入れました` : `予約のコラム「${title}」を出しました`,
              r.placed ? '公開は WordPress の編集の画面で行ってください' : '貼るだけのページを使っていれば、そこに出ています');
          }
        }
        // 承認されないまま公開の日時を過ぎた回は飛ばす（下書きのまま残す。勝手に公開しない）
        for (const c of (await this.deps.store.list(tenantId)).filter((x) => x.plannedFor && x.publishAt && Date.parse(x.publishAt) <= now.getTime()
          && ['writing', 'draft', 'awaiting', 'failed'].includes(x.status))) {
          await this.deps.store.update(tenantId, c.id, { plannedFor: null, publishAt: null });
          await this.audit(tenantId, SYSTEM, 'column.skip', c.id, { slot: c.plannedFor });
          await this.notify(tenantId, await this.recipients(tenantId), `${md(c.plannedFor!)}のコラムの回を飛ばしました`, `「${c.title || c.theme}」が承認されないまま公開の日時を過ぎました。下書きは残っています`);
          out.skipped += 1;
        }
        if (!w.topics.length) continue;
        // 週に 1 回のテーマ案（月曜の 6 時を過ぎてから。前から 6 日より経っていれば）
        const monday = jst.getUTCDay() === 1 && jst.getUTCHours() >= 6;
        if (monday && (!w.themesAt || now.getTime() - Date.parse(w.themesAt) > 6 * 86_400_000)) {
          const g = await this.generateThemes(tenantId, SYSTEM, now);
          if ('added' in g) out.themes += g.added.length;
        }
        // 7 日前の先回り（空いている回に、いちばん上のテーマ案で書き始める）
        if (w.plan) {
          for (const s of (await this.plan(tenantId, now)).filter((x) => !x.columnId && x.date > today && x.date <= addDays(today, COLUMN_PREPARE_DAYS))) {
            let pool = (await this.themes(tenantId)).filter((t) => !t.columnId);
            if (!pool.length) {
              await this.generateThemes(tenantId, SYSTEM, now, false);
              pool = (await this.themes(tenantId)).filter((t) => !t.columnId);
            }
            const t = pool[pool.length - 1] ?? pool[0];
            if (!t) break;
            const r = await this.writeFromTheme(this.system(tenantId), t.id, s.date);
            if ('error' in r) continue;
            await this.audit(tenantId, SYSTEM, 'column.prepare', r.columnId, { slot: s.date });
            await this.notify(tenantId, await this.recipients(tenantId), `${md(s.date)}のコラムの下書きを用意しています`, `「${t.theme}」で書いています。直して承認へ進めると、${md(s.date)}の 9 時に入れます`);
            out.prepared += 1;
          }
        }
      } catch (err) {
        this.log.warn('コラムの作成の見回りに失敗しました', { tenantId, error: String(err) });
      }
    }
    return out;
  }

  // ---- 貼るだけのページ（第32.10節） ------------------------------------------------------------

  /** 貼るだけのページを入れる（鍵を作る。もう入っていればそのまま）。 */
  async enablePage(who: ColumnViewer): Promise<{ key: string }> {
    const w = (await this.deps.repo.getTenantSettings(who.tenantId)).webColumns;
    if (w.pastePage) return { key: w.pastePage.key };
    const key = randomBytes(24).toString('base64url');
    await this.deps.repo.saveTenantSettings(who.tenantId, 'webColumns', { ...w, pastePage: { key, enabledAt: new Date().toISOString() } }, who.userId);
    await this.audit(who.tenantId, who.userId, 'column.page_enable', 'page', {});
    return { key };
  }

  /** 貼るだけのページを止める（鍵を捨てる。すぐ 404 になる）。 */
  async disablePage(who: ColumnViewer): Promise<void> {
    const w = (await this.deps.repo.getTenantSettings(who.tenantId)).webColumns;
    await this.deps.repo.saveTenantSettings(who.tenantId, 'webColumns', { ...w, pastePage: null }, who.userId);
    await this.audit(who.tenantId, who.userId, 'column.page_disable', 'page', {});
  }

  /**
   * 貼るだけのページの中身（鍵から会社を引く）。承認済みで公開の日時を過ぎたものだけ。
   *
   * @returns 鍵が違う・止めた会社は `null`
   */
  async pageByKey(key: string, now: Date = new Date()): Promise<{ tenantId: string; company: string; columns: PastePageColumn[] } | null> {
    if (!/^[A-Za-z0-9_-]{32}$/.test(key)) return null;
    const tenantId = await this.deps.store.tenantByPageKey(key);
    if (!tenantId) return null;
    const settings = await this.deps.repo.getTenantSettings(tenantId);
    if (!settings.webColumns.enabled || settings.webColumns.pastePage?.key !== key) return null;
    const shown = (await this.deps.store.list(tenantId)).filter((c) => c.status === 'approved' && (!c.publishAt || Date.parse(c.publishAt) <= now.getTime()));
    const columns: PastePageColumn[] = [];
    for (const c of shown.slice(0, 100)) {
      const v = (await this.deps.store.versions(tenantId, c.id)).find((x) => x.version === (c.submittedVersion ?? c.currentVersion));
      if (!v) continue;
      columns.push({
        id: c.id, title: v.title, description: v.description, html: columnHtml(finalMarkdown(v, settings.webColumns)),
        date: c.publishAt ?? c.updatedAt, hasCover: !!v.cover,
      });
    }
    columns.sort((a, b) => b.date.localeCompare(a.date));
    return { tenantId, company: settings.company.shortName || settings.company.legalName, columns };
  }

  /** 貼るだけのページのカバー画像（出しているコラムだけ）。 */
  async pageCover(key: string, columnId: string): Promise<Uint8Array | null> {
    const page = await this.pageByKey(key);
    if (!page || !page.columns.some((c) => c.id === columnId && c.hasCover)) return null;
    const c = await this.deps.store.get(page.tenantId, columnId);
    if (!c) return null;
    return this.deps.service.coverBytes({ tenantId: page.tenantId, userId: SYSTEM }, columnId, c.submittedVersion ?? undefined);
  }
}

/** 公開の URL（SNS の告知文に足す）。貼るだけのページなら記事の URL。 */
export function columnPublicUrl(c: Pick<WebColumn, 'id' | 'status'> & { webUrl?: string | null }, pageBase: string | null): string | null {
  if (c.webUrl) return c.webUrl;
  if (pageBase && c.status === 'approved') return `${pageBase}/${encodeURIComponent(c.id)}`;
  return null;
}
