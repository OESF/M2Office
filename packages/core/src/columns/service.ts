/**
 * @file Web のコラムの操作（仕様書 第32章・第32.18.1節）。画面（API）とツール（秘書と業務）が同じものを使う。
 *
 * 書く（裏で書き上げる）・直す（版を足す）・書き直しを頼む・直し案に置き換える・前の版に戻す・承認へ進める・
 * WordPress に下書きとして入れる・削除する。**承認した版だけを入れる。** 承認の後に版が変わっていれば入れない。
 * WordPress のアプリケーションパスワードは会社の接続の秘密の値として暗号化して預け、ここでだけ取り出す。
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  canUseAgent, WEB_COLUMNS_EXTENSION_ID,
  type ColumnReviewItem, type ColumnWordPress, type WebColumn, type WebColumnSettings, type WebColumnVersion,
} from '@m2office/shared';
import type { LlmProvider } from '../llm/provider.js';
import type { ResearchProvider } from '../research/provider.js';
import type { Repository } from '../repository/types.js';
import type { SecretBox } from '../secrets/box.js';
import { silentLogger, type Logger } from '../log/logger.js';
import type { ColumnStore, NewColumnVersion } from './store.js';
import { aiReview, mergeReview, ruleReview } from './review.js';
import { ColumnWriteError, rewriteColumn, writeColumn } from './writer.js';
import { checkWordPress, columnHtml, createWordPressDraft, normalizeSiteUrl, type WordPressAuth } from './wordpress.js';

/** コラムを扱う人。 */
export interface ColumnViewer {
  tenantId: string;
  userId: string;
}

/** 使うもの。 */
export interface ColumnServiceDeps {
  store: ColumnStore;
  repo: Repository;
  box: SecretBox;
  llmFor(tenantId: string): Promise<LlmProvider>;
  researchFor(tenantId: string): Promise<ResearchProvider>;
  logger?: Logger;
}

/** 1 つのコラムと版の一覧。 */
export interface ColumnDetail {
  column: WebColumn;
  /** 版（新しい順）。 */
  versions: WebColumnVersion[];
  /** 入れ先の WordPress（無ければ `null`）。 */
  wordpress: ColumnWordPress | null;
}

/** 承認の画面に出す要約と、承認した版を見分ける指紋。 */
export interface ColumnPreview {
  id: string;
  version: number;
  title: string;
  /** 本文の字数。 */
  chars: number;
  /** 残った指摘の数。 */
  reviewCount: number;
  /** 入れ先（「WordPress（https://…）の下書き」か「承認済みにするだけ」）。 */
  destination: string;
  /** 入れられない理由。空なら承認へ進める。 */
  problems: string[];
  digest: string;
}

/** テーマの長さの上限。 */
const THEME_MAX = 200;
/** 取材メモの長さの上限。 */
const MEMO_MAX = 4000;
/** 本文の長さの上限。 */
const BODY_MAX = 40_000;
/** 「書いています」のまま止まったとみなす時間（ミリ秒）。 */
const WRITING_STUCK_MS = 15 * 60_000;

/** WordPress の鍵の置き場の種類。 */
const WP_KIND = 'wordpress' as const;

/** 版の指紋（承認の後に版が変わっていないかを確かめる）。 */
function versionDigest(id: string, v: Pick<WebColumnVersion, 'version' | 'title' | 'body' | 'description'>): string {
  return createHash('sha256').update(JSON.stringify([id, v.version, v.title, v.body, v.description])).digest('hex');
}

/** 文字の数（空白を除く）。 */
const charCount = (s: string) => s.replace(/\s/g, '').length;

/**
 * 記事に入れる本文（Markdown）。末尾に出典・監修者・AI が書いたことの表示（入のとき）を足す（第32.9節）。
 */
export function finalMarkdown(v: Pick<WebColumnVersion, 'body' | 'sources'>, s: Pick<WebColumnSettings, 'supervisor' | 'aiNotice'>): string {
  const parts = [v.body.trim()];
  if (v.sources.length > 0) parts.push(['## 出典', '', ...v.sources.map((x, i) => `${i + 1}. [${x.title || x.url}](${x.url})`)].join('\n'));
  if (s.supervisor?.name) parts.push(`監修: ${[s.supervisor.title, s.supervisor.name].filter(Boolean).join(' ')}`);
  if (s.aiNotice) parts.push('この記事は AI の下書きをもとに、担当者が確かめて掲載しています。');
  return parts.join('\n\n');
}

/**
 * 利用者が Web のコラムを使えるかを確かめる関数を作る。使えるなら会社の設定を返す。
 *
 * @remarks 会社が切っているか、利用範囲（第16.7節）の外なら `null`
 */
export function webColumnsAccess(repo: Repository) {
  return async (tenantId: string, userId: string): Promise<WebColumnSettings | null> => {
    const settings = await repo.getTenantSettings(tenantId);
    if (!settings.webColumns.enabled) return null;
    const groups = await repo.listUserGroupIds(tenantId, userId);
    if (!canUseAgent(settings.access, WEB_COLUMNS_EXTENSION_ID, userId, groups)) return null;
    return settings.webColumns;
  };
}

/**
 * Web のコラムの操作。
 *
 * @remarks 呼ぶ前に、利用者が使えるかを {@link webColumnsAccess} で確かめること。設定と WordPress の鍵を管理者に限るのは呼ぶ側（API）
 */
export class ColumnService {
  private readonly log: Logger;

  constructor(private readonly deps: ColumnServiceDeps) {
    this.log = deps.logger ?? silentLogger;
  }

  get store(): ColumnStore {
    return this.deps.store;
  }

  /** コラムの一覧（新しい順）。止まった書き上げは「書けませんでした」にしてから返す。 */
  async list(tenantId: string): Promise<WebColumn[]> {
    await this.failStuck(tenantId);
    const [columns, users] = await Promise.all([this.deps.store.list(tenantId), this.deps.repo.listUsers(tenantId)]);
    const nameOf = new Map(users.map((u) => [u.id, u.displayName]));
    return columns.map((c) => ({ ...c, createdByName: nameOf.get(c.createdBy) ?? '（取得できませんでした）' }));
  }

  /** 1 つのコラムと版。見つからなければ `null`。承認待ちで実行が終わっていれば下書きに戻してから返す。 */
  async detail(who: ColumnViewer, id: string): Promise<ColumnDetail | null> {
    await this.failStuck(who.tenantId);
    await this.syncAwaiting(who, id);
    const column = await this.deps.store.get(who.tenantId, id);
    if (!column) return null;
    const [versions, users, settings] = await Promise.all([
      this.deps.store.versions(who.tenantId, id), this.deps.repo.listUsers(who.tenantId), this.deps.repo.getTenantSettings(who.tenantId),
    ]);
    const nameOf = (uid: string) => (uid === 'system' ? '秘書' : users.find((u) => u.id === uid)?.displayName ?? '（取得できませんでした）');
    return {
      column: { ...column, createdByName: nameOf(column.createdBy) },
      versions: versions.map((v) => ({ ...v, createdByName: nameOf(v.createdBy) })),
      wordpress: settings.webColumns.wordpress,
    };
  }

  /**
   * コラムを書き始める。記録を作り、書き上げは裏で進める（終わると下書き、書けなければ「書けませんでした」）。
   *
   * @param wait 書き上げを待つか（秘書のツールと自動テストは待つ）
   * @returns 作ったコラムの ID。作れなければ理由
   */
  async create(who: ColumnViewer, input: { theme: string; memo?: string }, wait = false): Promise<{ id: string } | { error: string }> {
    const theme = input.theme.trim().slice(0, THEME_MAX);
    if (!theme) return { error: 'テーマを入れてください' };
    const memo = (input.memo ?? '').trim().slice(0, MEMO_MAX);
    const id = await this.deps.store.create(who.tenantId, { theme, memo, createdBy: who.userId });
    await this.audit(who, 'column.create', id, { theme });
    const job = this.write(who, id);
    if (wait) await job;
    else void job;
    return { id };
  }

  /** 書けなかったコラムを、もう一度書く。 */
  async retry(who: ColumnViewer, id: string, wait = false): Promise<string | null> {
    const c = await this.deps.store.get(who.tenantId, id);
    if (!c) return 'コラムが見つかりません';
    if (c.status !== 'failed') return '書けなかったコラムだけを書き直せます';
    await this.deps.store.update(who.tenantId, id, { status: 'writing', failure: null });
    const job = this.write(who, id);
    if (wait) await job;
    else void job;
    return null;
  }

  /** 書き上げる（調べもの → 下書き → 赤入れ）。例外は外に出さず、「書けませんでした」と理由を残す。 */
  private async write(who: ColumnViewer, id: string): Promise<void> {
    const { store, repo } = this.deps;
    try {
      const c = await store.get(who.tenantId, id);
      if (!c) return;
      const settings = await repo.getTenantSettings(who.tenantId);
      const [llm, research, company] = await Promise.all([
        this.deps.llmFor(who.tenantId), this.deps.researchFor(who.tenantId), this.companyName(who.tenantId, settings.company.legalName),
      ]);
      const draft = await writeColumn(llm, research, {
        theme: c.theme, memo: c.memo, company, audience: settings.webColumns.audience, topics: settings.webColumns.topics,
        style: styleText(settings.writingStyle),
      });
      const review = mergeReview(
        ruleReview(draft.body, settings.webColumns.industry, draft.sources.length),
        await aiReview(llm, draft.body, settings.webColumns.industry),
      );
      await store.addVersion(who.tenantId, id, {
        title: draft.titles[0] ?? c.theme, titles: draft.titles, body: draft.body, description: draft.description, sns: draft.sns,
        sources: draft.sources, review, origin: 'writer', createdBy: who.userId,
      });
      await store.update(who.tenantId, id, { status: 'draft', failure: null });
    } catch (err) {
      const reason = err instanceof ColumnWriteError ? err.message : 'コラムを書けませんでした。時間をおいて書き直してください';
      this.log.warn('column.write_failed', { columnId: id, error: err instanceof Error ? err.message : String(err) });
      await store.update(who.tenantId, id, { status: 'failed', failure: reason }).catch(() => undefined);
    }
  }

  /**
   * 直して保存する（新しい版になる）。決まったプログラムの赤入れをやり直す。
   *
   * @returns 直せなければ理由
   */
  async saveEdit(who: ColumnViewer, id: string, patch: { title?: string; body?: string; description?: string; sns?: { short?: string; long?: string } }): Promise<string | null> {
    const cur = await this.editable(who, id);
    if (typeof cur === 'string') return cur;
    const next = {
      title: typeof patch.title === 'string' ? patch.title.trim().slice(0, 200) : cur.version.title,
      body: typeof patch.body === 'string' ? patch.body.slice(0, BODY_MAX) : cur.version.body,
      description: typeof patch.description === 'string' ? patch.description.trim().slice(0, 300) : cur.version.description,
      sns: {
        short: typeof patch.sns?.short === 'string' ? patch.sns.short.slice(0, 200) : cur.version.sns.short,
        long: typeof patch.sns?.long === 'string' ? patch.sns.long.slice(0, 600) : cur.version.sns.long,
      },
    };
    if (!next.title || !next.body.trim()) return '題名と本文を入れてください';
    if (next.title === cur.version.title && next.body === cur.version.body && next.description === cur.version.description
      && next.sns.short === cur.version.sns.short && next.sns.long === cur.version.sns.long) return null;
    await this.addVersion(who, id, cur.version, { ...cur.version, ...next, origin: 'edit' }, ruleReview(next.body, cur.settings.industry, cur.version.sources.length));
    return null;
  }

  /**
   * 指示で書き直してもらう（「もっと短く」など）。新しい版になり、赤入れをやり直す。
   *
   * @returns 書き直せなければ理由
   */
  async rewrite(who: ColumnViewer, id: string, instruction: string): Promise<string | null> {
    const text = instruction.trim().slice(0, 1000);
    if (!text) return '書き直しの指示を入れてください';
    const cur = await this.editable(who, id);
    if (typeof cur === 'string') return cur;
    const settings = await this.deps.repo.getTenantSettings(who.tenantId);
    const llm = await this.deps.llmFor(who.tenantId);
    try {
      const res = await rewriteColumn(llm, cur.version, text, styleText(settings.writingStyle));
      const review = mergeReview(ruleReview(res.body, cur.settings.industry, cur.version.sources.length), await aiReview(llm, res.body, cur.settings.industry));
      await this.addVersion(who, id, cur.version, { ...cur.version, body: res.body, description: res.description, origin: 'rewrite' }, review);
      return null;
    } catch (err) {
      return err instanceof ColumnWriteError ? err.message : '書き直せませんでした。時間をおいてもう一度頼んでください';
    }
  }

  /**
   * 赤入れの直し案に置き換える（今の版の `index` 番目の指摘）。新しい版になる。
   *
   * @returns 置き換えられなければ理由
   */
  async applySuggestion(who: ColumnViewer, id: string, index: number): Promise<string | null> {
    const cur = await this.editable(who, id);
    if (typeof cur === 'string') return cur;
    const item = cur.version.review[index];
    if (!item || !item.quote) return 'この指摘には直し案がありません';
    if (!cur.version.body.includes(item.quote)) return '指摘の箇所が本文に見つかりません（すでに直したかもしれません）';
    const body = cur.version.body.replace(item.quote, item.suggestion);
    // 置き換えた指摘を除き、残りはそのまま引き継ぐ（推論の指摘も残す）。決まったプログラムの指摘は新しい本文で数え直す
    const kept = cur.version.review.filter((r, i) => i !== index && r.by === 'ai' && body.includes(r.quote));
    await this.addVersion(who, id, cur.version, { ...cur.version, body, origin: 'suggestion' },
      mergeReview(ruleReview(body, cur.settings.industry, cur.version.sources.length), kept));
    return null;
  }

  /**
   * 前の版に戻す（その版を写した新しい版を足す。版は消さない）。
   *
   * @returns 戻せなければ理由
   */
  async restore(who: ColumnViewer, id: string, version: number): Promise<string | null> {
    const cur = await this.editable(who, id);
    if (typeof cur === 'string') return cur;
    const old = (await this.deps.store.versions(who.tenantId, id)).find((v) => v.version === version);
    if (!old) return 'その版が見つかりません';
    await this.addVersion(who, id, cur.version, { ...old, origin: 'restore' }, old.review);
    return null;
  }

  /**
   * 承認の画面に出す要約と、入れられない理由。見つからなければ `null`。
   */
  async preview(who: ColumnViewer, id: string): Promise<ColumnPreview | null> {
    const c = await this.deps.store.get(who.tenantId, id);
    if (!c) return null;
    const v = (await this.deps.store.versions(who.tenantId, id)).find((x) => x.version === c.currentVersion);
    const settings = await this.deps.repo.getTenantSettings(who.tenantId);
    const wp = settings.webColumns.wordpress;
    const hasKey = wp ? !!(await this.deps.repo.getTenantCredential(who.tenantId, WP_KIND)) : false;
    const problems: string[] = [];
    if (!v) problems.push('まだ書き上がっていません');
    if (c.status === 'writing') problems.push('書いている途中です');
    if (c.status === 'failed') problems.push('書けなかったコラムです。書き直してください');
    if (c.status === 'placed' && c.submittedVersion === c.currentVersion) problems.push('この版は WordPress に入れてあります');
    if (wp && !hasKey) problems.push('WordPress のアプリケーションパスワードが預けられていません。管理者に頼んでください');
    return {
      id, version: c.currentVersion, title: v?.title ?? '', chars: v ? charCount(v.body) : 0, reviewCount: v?.review.length ?? 0,
      destination: wp ? `WordPress（${wp.siteUrl}）の下書き` : 'WordPress につないでいないため、承認済みにするだけ',
      problems, digest: v ? versionDigest(id, v) : '',
    };
  }

  /** 承認待ちにする（業務の実行を始めたとき）。承認へ進めた版の指紋を残す。 */
  async markAwaiting(who: ColumnViewer, id: string, runId: string, p: ColumnPreview): Promise<void> {
    await this.deps.store.update(who.tenantId, id, { status: 'awaiting', runId, submittedVersion: p.version, submittedDigest: p.digest });
    await this.audit(who, 'column.submit', id, { version: p.version, reviewCount: p.reviewCount });
  }

  /** 承認待ちで、実行が承認を待たなくなっていれば（却下・失敗・取り消し）、下書きに戻す。 */
  async syncAwaiting(who: ColumnViewer, id: string): Promise<void> {
    const c = await this.deps.store.get(who.tenantId, id);
    if (c?.status !== 'awaiting' || !c.runId) return;
    const run = await this.deps.repo.getRun(who.tenantId, c.runId);
    if (!run || ['completed', 'failed', 'cancelled', 'expired'].includes(run.status)) {
      await this.deps.store.update(who.tenantId, id, { status: 'draft', runId: null });
    }
  }

  /**
   * 承認されたコラムを WordPress に下書きとして入れる（`columns.place` が承認の後に呼ぶ）。WordPress が無ければ承認済みにする。
   *
   * @param digest 承認したときの版の指紋。今の版と違えば入れない
   * @returns 入れた先（編集の画面の URL）。入れられなければ理由
   */
  async place(who: ColumnViewer, id: string, digest: string): Promise<{ placed: boolean; editUrl: string | null } | { error: string }> {
    const { store, repo } = this.deps;
    const c = await store.get(who.tenantId, id);
    if (!c) return { error: 'コラムが見つかりません' };
    if (c.status !== 'awaiting' && c.status !== 'draft') return { error: 'このコラムは承認へ進めた状態ではありません' };
    const p = await this.preview(who, id);
    if (!p) return { error: 'コラムが見つかりません' };
    if (p.problems.length > 0) return { error: p.problems.join('／') };
    if (p.digest !== digest) return { error: '承認した後にコラムが直されたため、入れませんでした。もう一度承認へ進めてください' };
    const v = (await store.versions(who.tenantId, id)).find((x) => x.version === p.version)!;
    const settings = (await repo.getTenantSettings(who.tenantId)).webColumns;
    if (!settings.wordpress) {
      await store.update(who.tenantId, id, { status: 'approved', submittedVersion: v.version, runId: null });
      await this.audit(who, 'column.approve', id, { version: v.version });
      return { placed: false, editUrl: null };
    }
    const auth = await this.wordpressAuth(who.tenantId, settings.wordpress);
    if (!auth) return { error: 'WordPress のアプリケーションパスワードが預けられていません' };
    const res = await createWordPressDraft(auth, { title: v.title, html: columnHtml(finalMarkdown(v, settings)), excerpt: v.description });
    if ('error' in res) return { error: res.error };
    await store.update(who.tenantId, id, { status: 'placed', submittedVersion: v.version, wpPostId: res.id, wpEditUrl: res.editUrl, runId: null });
    await this.audit(who, 'column.place', id, { version: v.version, site: settings.wordpress.siteUrl, postId: res.id });
    return { placed: true, editUrl: res.editUrl };
  }

  /** 削除する（承認へ進めていないものだけ）。 */
  async remove(who: ColumnViewer, id: string): Promise<string | null> {
    await this.syncAwaiting(who, id);
    const c = await this.deps.store.get(who.tenantId, id);
    if (!c) return 'コラムが見つかりません';
    if (c.status === 'awaiting' || c.status === 'approved' || c.status === 'placed') return '承認へ進めたコラムは削除できません';
    if (c.status === 'writing') return '書いている途中は削除できません';
    await this.deps.store.delete(who.tenantId, id);
    await this.audit(who, 'column.delete', id, { theme: c.theme });
    return null;
  }

  /** 記事に入れる形（Markdown と HTML）。写して使う。見つからなければ `null`。 */
  async exported(who: ColumnViewer, id: string): Promise<{ title: string; markdown: string; html: string; description: string } | null> {
    const c = await this.deps.store.get(who.tenantId, id);
    if (!c) return null;
    const v = (await this.deps.store.versions(who.tenantId, id)).find((x) => x.version === c.currentVersion);
    if (!v) return null;
    const markdown = finalMarkdown(v, (await this.deps.repo.getTenantSettings(who.tenantId)).webColumns);
    return { title: v.title, markdown, html: columnHtml(markdown), description: v.description };
  }

  // ---- WordPress の鍵（管理者） ----------------------------------------------

  /**
   * WordPress の入れ先と鍵を預ける。つながるかを確かめてから預ける。
   *
   * @returns 預けた入れ先。つながらなければ理由
   */
  async saveWordPress(who: ColumnViewer, input: { siteUrl: string; username: string; password: string }): Promise<{ wordpress: ColumnWordPress } | { error: string }> {
    const siteUrl = normalizeSiteUrl(input.siteUrl);
    if (!siteUrl) return { error: 'サイトの URL を https:// から入れてください' };
    const username = input.username.trim();
    const password = input.password.trim();
    if (!username || !password) return { error: '利用者名とアプリケーションパスワードを入れてください' };
    const check = await checkWordPress({ siteUrl, username, password });
    if (!check.ok) return { error: check.error };
    const { repo, box } = this.deps;
    await repo.saveTenantCredential({
      tenantId: who.tenantId, kind: WP_KIND, secretEnc: box.encrypt(password), meta: { siteUrl, username },
      updatedBy: who.userId, updatedAt: new Date().toISOString(),
    });
    const settings = await repo.getTenantSettings(who.tenantId);
    const wordpress = { siteUrl, username };
    await repo.saveTenantSettings(who.tenantId, 'webColumns', { ...settings.webColumns, wordpress }, who.userId);
    await this.audit(who, 'column.wordpress_save', who.tenantId, { siteUrl, username });
    return { wordpress };
  }

  /** WordPress の入れ先と鍵を外す。 */
  async removeWordPress(who: ColumnViewer): Promise<void> {
    const { repo } = this.deps;
    await repo.deleteTenantCredential(who.tenantId, WP_KIND);
    const settings = await repo.getTenantSettings(who.tenantId);
    await repo.saveTenantSettings(who.tenantId, 'webColumns', { ...settings.webColumns, wordpress: null }, who.userId);
    await this.audit(who, 'column.wordpress_remove', who.tenantId, {});
  }

  // ---- 内部 --------------------------------------------------------------------

  /** 直せる状態なら今の版と設定を返す。直せなければ理由。承認済み・入れたものは直すと下書きに戻る。 */
  private async editable(who: ColumnViewer, id: string): Promise<{ version: WebColumnVersion; settings: WebColumnSettings } | string> {
    await this.syncAwaiting(who, id);
    const c = await this.deps.store.get(who.tenantId, id);
    if (!c) return 'コラムが見つかりません';
    if (c.status === 'writing') return '書いている途中です。書き上がるまで待ってください';
    if (c.status === 'awaiting') return '承認待ちの間は直せません。承認か却下を待ってください';
    const version = (await this.deps.store.versions(who.tenantId, id)).find((v) => v.version === c.currentVersion);
    if (!version) return 'まだ書き上がっていません';
    return { version, settings: (await this.deps.repo.getTenantSettings(who.tenantId)).webColumns };
  }

  /** 版を足し、下書きにする（承認済み・入れたものを直したら、もう一度承認が要る）。 */
  private async addVersion(who: ColumnViewer, id: string, cur: WebColumnVersion, next: Omit<NewColumnVersion, 'review' | 'createdBy'>, review: ColumnReviewItem[]): Promise<void> {
    await this.deps.store.addVersion(who.tenantId, id, {
      title: next.title, titles: next.titles ?? cur.titles, body: next.body, description: next.description, sns: next.sns, sources: next.sources,
      review, origin: next.origin, createdBy: who.userId,
    });
    await this.deps.store.update(who.tenantId, id, { status: 'draft', failure: null });
  }

  /** 「書いています」のまま止まったものを「書けませんでした」にする（サーバーの再起動などで書き上げが途切れた）。 */
  private async failStuck(tenantId: string): Promise<void> {
    const ids = await this.deps.store.stuckWriting(tenantId, new Date(Date.now() - WRITING_STUCK_MS).toISOString()).catch(() => [] as string[]);
    for (const id of ids) {
      await this.deps.store.update(tenantId, id, { status: 'failed', failure: '書き上げが途中で止まりました。書き直してください' });
    }
  }

  private async wordpressAuth(tenantId: string, wp: ColumnWordPress): Promise<WordPressAuth | null> {
    const cred = await this.deps.repo.getTenantCredential(tenantId, WP_KIND);
    if (!cred?.secretEnc) return null;
    return { siteUrl: wp.siteUrl, username: wp.username, password: this.deps.box.decrypt(cred.secretEnc) };
  }

  private async companyName(tenantId: string, legalName: string): Promise<string> {
    if (legalName.trim()) return legalName.trim();
    const tenant = await this.deps.repo.findTenantById(tenantId).catch(() => null);
    return tenant?.name ?? '';
  }

  private async audit(who: ColumnViewer, action: string, id: string, detail: Record<string, unknown>): Promise<void> {
    await this.deps.repo.appendAudit({
      id: randomUUID(), tenantId: who.tenantId, actorType: 'user', actorId: who.userId, action, targetType: 'web_column', targetId: id,
      detail, occurredAt: new Date().toISOString(),
    });
  }
}

/** 自社の書き方（第15.2.1節）を、コラムを書く指示に渡す短い文にする。 */
function styleText(w: { selfReference: string; terms: { use: string; avoid: string }[]; notes: string }): string {
  return [
    w.selfReference ? `自社のことは「${w.selfReference}」と書く` : '',
    ...w.terms.map((t) => `「${t.avoid}」ではなく「${t.use}」と書く`),
    w.notes,
  ].filter(Boolean).join('。');
}
