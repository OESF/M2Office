/**
 * @file Web のコラムの操作（仕様書 第32章・第32.18.1節）。画面（API）とツール（秘書と業務）が同じものを使う。
 *
 * 書く（裏で書き上げる）・直す（版を足す）・書き直しを頼む・直し案に置き換える・前の版に戻す・承認へ進める・
 * WordPress に下書きとして入れる・削除する。**承認した版だけを入れる。** 承認の後に版が変わっていれば入れない。
 * WordPress のアプリケーションパスワードは会社の接続の秘密の値として暗号化して預け、ここでだけ取り出す。
 * カバー画像（第32.7.1節・第32.18.2節）は版に含め、書き上げたときと「作り直す」で作る。
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  canUseAgent, WEB_COLUMNS_EXTENSION_ID,
  type ColumnCoverKind, type ColumnReviewItem, type ColumnRuleSet, type ColumnWordPress, type WebColumn, type WebColumnCover,
  type WebColumnSettings, type WebColumnVersion,
} from '@m2office/shared';
import type { LlmProvider } from '../llm/provider.js';
import type { ResearchProvider } from '../research/provider.js';
import type { Repository } from '../repository/types.js';
import type { SecretBox } from '../secrets/box.js';
import type { FileStore } from '../files/store.js';
import { saveFile } from '../files/service.js';
import { silentLogger, type Logger } from '../log/logger.js';
import type { ColumnStore, NewColumnVersion } from './store.js';
import { aiReview, mergeReview, ruleReview } from './review.js';
import { inferRuleSets } from './rules.js';
import { ColumnWriteError, rewriteColumn, writeColumn } from './writer.js';
import { checkWordPress, columnHtml, createWordPressDraft, normalizeSiteUrl, setWordPressStatus, uploadWordPressMedia, type WordPressAuth } from './wordpress.js';
import { similarityReview } from './plan.js';
import type { PageFetcher } from '../competitors/fetcher.js';
import {
  COVER_AI_MODEL, COVER_AI_MONTHLY_LIMIT, COVER_AI_TRIES, COVER_MIN_BRIGHTNESS, COVER_MIN_PHOTO_BRIGHTNESS, brandColor, brightness, checkIllustration, choosePhoto, describePhoto, fallbackColor,
  illustrationPrompt, imageWish, pickPattern, renderCover, wantsDark, type CoverInput,
} from './cover.js';

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
  /** カバー画像と会社の写真の置き場。 */
  files: FileStore;
  /** 出典のページを読む口（似すぎの確かめ。第32.18.4節）。見本の会社・読めない環境では `null` */
  pagesFor?(tenantId: string): PageFetcher | null;
  logger?: Logger;
}

/** カバーを作り直すときの頼み方（画面と秘書）。 */
export interface CoverRequest {
  /** 背景の種類。無ければ決まった順（AI の挿絵 → 会社の写真 → 型）で選ぶ。 */
  kind?: ColumnCoverKind;
  /** 雰囲気の頼み（「もっと明るく」など）。AI の挿絵に渡す。 */
  hint?: string;
  /** 使う会社の写真（写真を入れたとき）。 */
  photoId?: string;
}

/** 写真として受け取れる形。 */
const PHOTO_MIME: Record<string, 'png' | 'jpeg'> = { 'image/png': 'png', 'image/jpeg': 'jpeg' };
/** 写真の大きさの上限。 */
export const COLUMN_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

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
  /** 今の版のカバー画像（無ければ `null`）。 */
  cover: WebColumnCover | null;
  /** 入れられない理由。空なら承認へ進める。 */
  problems: string[];
  digest: string;
  /** 公開の日時（予約。無ければ `null`。第32.18.4節） */
  publishAt: string | null;
}

/** テーマの長さの上限。 */
const THEME_MAX = 200;
/** リクエスト（書く人の希望・経験・考え。画像の希望も書ける）の長さの上限。 */
const MEMO_MAX = 4000;
/** 本文の長さの上限。 */
const BODY_MAX = 40_000;
/** 「書いています」のまま止まったとみなす時間（ミリ秒）。 */
const WRITING_STUCK_MS = 15 * 60_000;

/** WordPress の鍵の置き場の種類。 */
const WP_KIND = 'wordpress' as const;

/** 版の指紋（承認の後に版が変わっていないかを確かめる）。 */
function versionDigest(id: string, v: Pick<WebColumnVersion, 'version' | 'title' | 'body' | 'description' | 'cover'>, publishAt: string | null = null): string {
  // 公開の日時（予約）も承認した中身に含める（第32.18.4節）。日時が無い版は前と同じ指紋になる
  return createHash('sha256').update(JSON.stringify([id, v.version, v.title, v.body, v.description, v.cover?.fileId ?? null, ...(publishAt ? [publishAt] : [])])).digest('hex');
}

/** 今月の始まり（日本の時刻。月の上限を数える）。 */
function monthStartIso(now = new Date()): string {
  const jst = new Date(now.getTime() + 9 * 3600_000);
  return new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), 1) - 9 * 3600_000).toISOString();
}

/** 文字の数（空白を除く）。 */
const charCount = (s: string) => s.replace(/\s/g, '').length;

/**
 * 記事に入れる本文（Markdown）。末尾に出典・監修者・AI が書いたことの表示（入のとき）を足す（第32.9節）。
 */
export function finalMarkdown(v: Pick<WebColumnVersion, 'body' | 'sources'> & { cover?: WebColumnCover | null }, s: Pick<WebColumnSettings, 'supervisor' | 'aiNotice'>): string {
  const parts = [v.body.trim()];
  if (v.sources.length > 0) parts.push(['## 出典', '', ...v.sources.map((x, i) => `${i + 1}. [${x.title || x.url}](${x.url})`)].join('\n'));
  if (s.supervisor?.name) parts.push(`監修: ${[s.supervisor.title, s.supervisor.name].filter(Boolean).join(' ')}`);
  if (s.aiNotice) parts.push(`この記事は AI の下書きをもとに、担当者が確かめて掲載しています。${v.cover?.kind === 'ai' ? 'カバー画像は AI で作成しました。' : ''}`);
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
  /** 会社のロゴから選んだ色（会社とロゴのファイルごと）。ロゴを替えると選び直す。 */
  private readonly colors = new Map<string, string | null>();

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
        style: styleText({ ...settings.writingStyle, selfReference: '' }), selfReference: settings.writingStyle.selfReference,
      });
      const review = [...mergeReview(
        ruleReview(draft.body, settings.webColumns.rules, draft.sources.length),
        await aiReview(llm, draft.body, settings.webColumns.rules),
      ), ...(await this.similar(who.tenantId, draft.body, draft.sources))];
      const title = draft.titles[0] ?? c.theme;
      // カバーを作れなくても、下書きは残す（画面の「画像を作成」で作れる）
      const made = await this.makeCover(who, { title, description: draft.description, request: c.memo }, {}).catch((err: unknown) => {
        this.log.warn('column.cover_failed', { columnId: id, error: err instanceof Error ? err.message : String(err) });
        return null;
      });
      const cover = typeof made === 'string' ? null : made;
      await store.addVersion(who.tenantId, id, {
        title, titles: draft.titles, body: draft.body, description: draft.description, sns: draft.sns,
        sources: draft.sources, review, cover, origin: 'writer', createdBy: who.userId,
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
    await this.addVersion(who, id, cur.version, { ...cur.version, ...next, origin: 'edit' }, ruleReview(next.body, cur.settings.rules, cur.version.sources.length));
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
      const review = [...mergeReview(ruleReview(res.body, cur.settings.rules, cur.version.sources.length), await aiReview(llm, res.body, cur.settings.rules)),
        ...(await this.similar(who.tenantId, res.body, cur.version.sources))];
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
      mergeReview(ruleReview(body, cur.settings.rules, cur.version.sources.length), kept));
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
    if (v && !v.cover) problems.push('カバー画像がありません。「画像を作成」で作ってください');
    const publishAt = c.publishAt ?? null;
    if (publishAt && c.status !== 'scheduled' && Date.parse(publishAt) < Date.now()) problems.push('公開の日時が過ぎています。日時を直すか、外してください');
    const at = publishAt ? new Date(publishAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const page = settings.webColumns.pastePage ? '貼るだけのページに出す' : '承認済みにするだけ（本文をコピーして使う）';
    return {
      id, version: c.currentVersion, title: v?.title ?? '', chars: v ? charCount(v.body) : 0, reviewCount: v?.review.length ?? 0,
      destination: `${wp ? `WordPress（${wp.siteUrl}）の下書き` : `WordPress につないでいないため、${page}`}${at ? `（${at} に入れる。予約）` : ''}`,
      cover: v?.cover ?? null, problems, digest: v ? versionDigest(id, v, publishAt) : '', publishAt,
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
  async place(who: ColumnViewer, id: string, digest: string): Promise<{ placed: boolean; editUrl: string | null; scheduledAt?: string } | { error: string }> {
    const { store, repo } = this.deps;
    const c = await store.get(who.tenantId, id);
    if (!c) return { error: 'コラムが見つかりません' };
    if (c.status !== 'awaiting' && c.status !== 'draft') return { error: 'このコラムは承認へ進めた状態ではありません' };
    const p = await this.preview(who, id);
    if (!p) return { error: 'コラムが見つかりません' };
    if (p.problems.length > 0) return { error: p.problems.join('／') };
    if (p.digest !== digest) return { error: '承認した後にコラムが直されたため、入れませんでした。もう一度承認へ進めてください' };
    // 公開の日時が先なら予約にして待つ（その日時にワーカーが入れる。第32.18.4節）
    if (p.publishAt && Date.parse(p.publishAt) > Date.now()) {
      await store.update(who.tenantId, id, { status: 'scheduled', submittedVersion: p.version, submittedDigest: p.digest, runId: null });
      await this.audit(who, 'column.schedule', id, { version: p.version, publishAt: p.publishAt });
      return { placed: false, editUrl: null, scheduledAt: p.publishAt };
    }
    return this.placeVersion(who, id, p.version);
  }

  /**
   * 予約のコラムを、公開の日時に入れる（ワーカーが呼ぶ）。承認した版の指紋と違えば入れず、下書きに戻す。
   *
   * @returns 入れた先。入れられなければ理由
   */
  async placeScheduled(who: ColumnViewer, id: string): Promise<{ placed: boolean; editUrl: string | null } | { error: string }> {
    const { store } = this.deps;
    const c = await store.get(who.tenantId, id);
    if (c?.status !== 'scheduled') return { error: 'このコラムは予約ではありません' };
    const v = (await store.versions(who.tenantId, id)).find((x) => x.version === c.currentVersion);
    const approved = await store.submittedDigest(who.tenantId, id);
    if (!v || !approved || versionDigest(id, v, c.publishAt ?? null) !== approved) {
      await store.update(who.tenantId, id, { status: 'draft' });
      return { error: '承認した後にコラムが直されたため、入れませんでした。もう一度承認へ進めてください' };
    }
    return this.placeVersion(who, id, v.version);
  }

  /** 承認した版を入れる（WordPress の下書き。無ければ承認済みにする）。 */
  private async placeVersion(who: ColumnViewer, id: string, version: number): Promise<{ placed: boolean; editUrl: string | null } | { error: string }> {
    const { store, repo } = this.deps;
    const v = (await store.versions(who.tenantId, id)).find((x) => x.version === version)!;
    const settings = (await repo.getTenantSettings(who.tenantId)).webColumns;
    if (!settings.wordpress) {
      await store.update(who.tenantId, id, { status: 'approved', submittedVersion: v.version, runId: null });
      await this.audit(who, 'column.approve', id, { version: v.version });
      return { placed: false, editUrl: null };
    }
    const auth = await this.wordpressAuth(who.tenantId, settings.wordpress);
    if (!auth) return { error: 'WordPress のアプリケーションパスワードが預けられていません' };
    // カバーをメディアに入れ、アイキャッチにする（第32.18.2節）
    let media: string | null = null;
    if (v.cover) {
      const bytes = await this.deps.files.get(who.tenantId, v.cover.fileId);
      if (!bytes) return { error: 'カバー画像を読めませんでした。カバーを作り直してから、もう一度承認へ進めてください' };
      const up = await uploadWordPressMedia(auth, { bytes, fileName: `column-cover-${id.slice(4, 12)}.png`, mimeType: 'image/png', alt: v.cover.alt });
      if ('error' in up) return { error: up.error };
      media = up.id;
    }
    const res = await createWordPressDraft(auth, { title: v.title, html: columnHtml(finalMarkdown(v, settings)), excerpt: v.description, featuredMedia: media });
    if ('error' in res) return { error: res.error };
    await store.update(who.tenantId, id, { status: 'placed', submittedVersion: v.version, wpPostId: res.id, wpEditUrl: res.editUrl, runId: null });
    await this.audit(who, 'column.place', id, { version: v.version, site: settings.wordpress.siteUrl, postId: res.id });
    return { placed: true, editUrl: res.editUrl };
  }

  /**
   * 公開の日時（予約）を入れる・外す（下書きのときだけ。第32.18.4節）。
   *
   * @param at ISO の日時。`null` で外す
   * @returns 入れられなければ理由
   */
  async setPublishAt(who: ColumnViewer, id: string, at: string | null): Promise<string | null> {
    const c = await this.deps.store.get(who.tenantId, id);
    if (!c) return 'コラムが見つかりません';
    if (c.status !== 'draft' && c.status !== 'writing' && c.status !== 'failed' && c.status !== 'withdrawn') return '下書きのときだけ、公開の日時を変えられます';
    if (at !== null && (Number.isNaN(Date.parse(at)) || Date.parse(at) < Date.now())) return '公開の日時は、これからの日時にしてください';
    await this.deps.store.update(who.tenantId, id, { publishAt: at === null ? null : new Date(at).toISOString() });
    await this.audit(who, 'column.publish_at', id, { publishAt: at });
    return null;
  }

  /**
   * 取り下げる（承認済み・予約・入れたもの。第32.10節）。貼るだけのページから外し、WordPress では記事を下書きに戻す。
   *
   * @returns 取り下げられなければ理由
   */
  async withdraw(who: ColumnViewer, id: string): Promise<string | null> {
    const { store, repo } = this.deps;
    const c = await store.get(who.tenantId, id);
    if (!c) return 'コラムが見つかりません';
    if (c.status !== 'approved' && c.status !== 'scheduled' && c.status !== 'placed') return '承認済み・予約・入れたコラムだけを取り下げられます';
    if (c.status === 'placed') {
      const settings = (await repo.getTenantSettings(who.tenantId)).webColumns;
      const postId = (await store.placed(who.tenantId)).find((x) => x.id === id)?.wpPostId ?? null;
      const auth = settings.wordpress ? await this.wordpressAuth(who.tenantId, settings.wordpress) : null;
      if (postId && auth) {
        const err = await setWordPressStatus(auth, postId, 'draft');
        if (err) return err;
      }
    }
    await store.update(who.tenantId, id, { status: 'withdrawn', webUrl: null });
    await this.audit(who, 'column.withdraw', id, { from: c.status });
    return null;
  }

  /** 似すぎの確かめ（出典のページを読める会社だけ。読めなければ空）。 */
  private async similar(tenantId: string, body: string, sources: { title: string; url: string }[]): Promise<ColumnReviewItem[]> {
    const fetcher = this.deps.pagesFor?.(tenantId) ?? null;
    if (!fetcher || !sources.length) return [];
    return similarityReview(body, sources, fetcher).catch(() => []);
  }

  // ---- カバー画像（第32.7.1節・第32.18.2節） -----------------------------------

  /**
   * カバーを作り直す（新しい版になる）。
   *
   * @returns 作り直せなければ理由
   */
  async recover(who: ColumnViewer, id: string, req: CoverRequest = {}): Promise<string | null> {
    const cur = await this.editable(who, id);
    if (typeof cur === 'string') return cur;
    if (req.photoId && !(await this.deps.store.photos(who.tenantId)).some((p) => p.id === req.photoId)) return 'その写真が見つかりません';
    const request = (await this.deps.store.get(who.tenantId, id))?.memo ?? '';
    const cover = await this.makeCover(who, { title: cur.version.title, description: cur.version.description, request }, req);
    if (typeof cover === 'string') return cover;
    await this.addVersion(who, id, cur.version, { ...cur.version, cover, origin: 'cover' }, cur.version.review);
    return null;
  }

  /**
   * 前に作ったカバーに戻す（そのカバーを写した新しい版を足す。本文はいまのまま。第32.18.2節）。
   *
   * @param fileId このコラムの前の版のカバーのファイル。`previous` なら、いまのカバーの 1 つ前のもの
   * @returns 戻せなければ理由
   */
  async useCover(who: ColumnViewer, id: string, fileId: string | 'previous'): Promise<string | null> {
    const cur = await this.editable(who, id);
    if (typeof cur === 'string') return cur;
    const covers = this.pastCovers(await this.deps.store.versions(who.tenantId, id), cur.version.cover?.fileId ?? null);
    const pick = fileId === 'previous' ? covers[0] : covers.find((c) => c.cover.fileId === fileId);
    if (!pick) return fileId === 'previous' ? '前に作った画像がありません' : 'その画像が見つかりません';
    await this.addVersion(who, id, cur.version, { ...cur.version, cover: pick.cover, origin: 'cover' }, cur.version.review);
    return null;
  }

  /** 前に作ったカバー（新しい順。いまのカバーと同じものは除き、同じ画像は 1 つにする）。画面の「以前の画像」に出す。 */
  pastCovers(versions: WebColumnVersion[], currentFileId: string | null): { version: number; cover: WebColumnCover }[] {
    const seen = new Set<string>(currentFileId ? [currentFileId] : []);
    const out: { version: number; cover: WebColumnCover }[] = [];
    for (const v of versions) {
      if (!v.cover || seen.has(v.cover.fileId)) continue;
      seen.add(v.cover.fileId);
      out.push({ version: v.version, cover: v.cover });
    }
    return out;
  }

  /**
   * 会社の写真の置き場に写真を入れ、そのコラムのカバーにする。写真の説明と人が写っているかは推論が読む。
   *
   * @returns 入れられなければ理由
   */
  async addPhoto(who: ColumnViewer, id: string, photo: { bytes: Uint8Array; mimeType: string; name: string }): Promise<string | null> {
    const kind = PHOTO_MIME[photo.mimeType];
    if (!kind) return '写真は JPEG か PNG にしてください';
    if (photo.bytes.byteLength > COLUMN_PHOTO_MAX_BYTES) return '写真は 10 MB までです';
    const cur = await this.editable(who, id);
    if (typeof cur === 'string') return cur;
    const llm = await this.deps.llmFor(who.tenantId);
    const meta = await saveFile(this.deps.repo, this.deps.files, {
      tenantId: who.tenantId, ownerUserId: who.userId, name: photo.name || `photo.${kind === 'png' ? 'png' : 'jpg'}`, kind, bytes: photo.bytes, origin: 'upload', runId: null,
    });
    const read = await describePhoto(llm, { bytes: photo.bytes, mimeType: photo.mimeType });
    const saved = await this.deps.store.addPhoto(who.tenantId, { fileId: meta.id, description: read.description, hasPeople: read.hasPeople, createdBy: who.userId });
    await this.audit(who, 'column.photo_add', id, { photoId: saved.id });
    return this.recover(who, id, { kind: 'photo', photoId: saved.id });
  }

  /** カバー画像の中身（PNG）。見つからなければ `null`。 */
  async coverBytes(who: ColumnViewer, id: string, version?: number): Promise<Uint8Array | null> {
    const c = await this.deps.store.get(who.tenantId, id);
    if (!c) return null;
    const v = (await this.deps.store.versions(who.tenantId, id)).find((x) => x.version === (version ?? c.currentVersion));
    return v?.cover ? this.deps.files.get(who.tenantId, v.cover.fileId) : null;
  }

  /** 今月、AI の挿絵を描いた枚数と上限。 */
  async aiUsage(tenantId: string): Promise<{ used: number; limit: number }> {
    return { used: await this.deps.store.aiAttemptsSince(tenantId, monthStartIso()), limit: COVER_AI_MONTHLY_LIMIT };
  }

  /**
   * カバーを作る。決まった順（頼まれた種類があればそれ）で背景を選び、題名を重ねて PNG にする。
   *
   * @returns 作ったカバー。頼まれた種類で作れなければ理由
   */
  private async makeCover(who: ColumnViewer, a: { title: string; description: string; request?: string }, req: CoverRequest): Promise<WebColumnCover | string> {
    const { repo, store } = this.deps;
    const settings = await repo.getTenantSettings(who.tenantId);
    const llm = await this.deps.llmFor(who.tenantId);
    const logo = await this.logo(who.tenantId, settings.company.logoFileId);
    // ロゴは画像に入れず、型の色を選ぶのにだけ使う（第32.18.2節）
    const base = { title: a.title };
    const notes: string[] = [];
    let aiAttempts = 0;

    // ① AI の挿絵（会社が入れていて、描けて確かめられ、今月の上限の内のとき）
    const wantAi = req.kind === 'ai' || (!req.kind && settings.webColumns.aiIllustration);
    if (wantAi) {
      const can = settings.webColumns.aiIllustration && llm.generateImage && llm.extractFromImage;
      const usage = can ? await this.aiUsage(who.tenantId) : null;
      if (!settings.webColumns.aiIllustration) notes.push('AI で挿絵を描く設定が切りのため、型にしました');
      else if (!can) notes.push('この会社の AI では挿絵を描けないため、型にしました');
      else if (usage && usage.used >= usage.limit) notes.push(`今月の AI の挿絵の上限（${usage.limit} 枚）に達したため、型にしました`);
      else {
        const tries = Math.min(COVER_AI_TRIES, usage!.limit - usage!.used);
        // 雰囲気: 秘書への頼みを先に、無ければ「リクエスト」に書いた画像の希望（画像の希望だけを取り出し、会社やお客様の情報は渡さない）
        const hint = (req.hint?.trim() || (a.request ? await imageWish(llm, a.request) : '')).slice(0, 200);
        for (let i = 0; i < tries; i++) {
          aiAttempts += 1;
          const img = await llm.generateImage!({
            model: COVER_AI_MODEL, aspectRatio: '16:9',
            prompt: illustrationPrompt({ title: a.title, description: a.description, rules: settings.webColumns.rules, hint }),
          }).catch(() => null);
          if (!img) { notes.push('挿絵を描けませんでした'); continue; }
          // 暗い挿絵は Web のページを暗く見せるため描き直す（暗い雰囲気を頼まれたときは除く）
          if (!wantsDark(hint) && (brightness(img) ?? 1) < COVER_MIN_BRIGHTNESS) { notes.push('暗い画像だったため描き直しました'); continue; }
          const check = await checkIllustration(llm, img, settings.webColumns.rules);
          if (!check.ok) { notes.push(check.reason); continue; }
          return this.saveCover(who, { ...base, background: { kind: 'image', image: img } }, { kind: 'ai', pattern: null, photoId: null, aiAttempts, note: notes.join('／'), alt: altText(a.title, 'ai') });
        }
        notes.push('確かめを通る挿絵ができなかったため、型にしました');
      }
    }

    // ② 会社の写真（選んだ写真か、推論が記事に合うと選んだもの）
    if (req.kind === 'photo' || (!req.kind && req.photoId === undefined)) {
      const photos = await store.photos(who.tenantId);
      const photo = req.photoId ? photos.find((p) => p.id === req.photoId) ?? null : await choosePhoto(llm, photos, a);
      if (photo) {
        const bytes = await this.deps.files.get(who.tenantId, photo.fileId);
        const meta = bytes ? await repo.getFile(who.tenantId, photo.fileId) : null;
        // 推論が選んだ写真が暗ければ使わない（人が選んだ写真はそのまま使う）
        const dark = !req.photoId && bytes && meta && (brightness({ bytes, mimeType: meta.mime }) ?? 1) < COVER_MIN_PHOTO_BRIGHTNESS;
        if (dark) notes.push('記事に合う写真が暗かったため、型にしました');
        else if (bytes && meta) {
          return this.saveCover(who, { ...base, background: { kind: 'image', image: { bytes, mimeType: meta.mime } } },
            { kind: 'photo', pattern: null, photoId: photo.id, aiAttempts, note: notes.join('／'), alt: photo.description || altText(a.title, 'photo') });
        }
      }
      if (req.kind === 'photo') return photos.length === 0 ? 'まだ会社の写真がありません。「ファイルから選択」で選んでください' : '記事に合う写真が見つかりませんでした。「ファイルから選択」で選んでください';
    }

    // ③ 型
    const pattern = pickPattern(await store.recentPatterns(who.tenantId, 6));
    const color = (logo ? await this.logoColor(who.tenantId, settings.company.logoFileId!, llm, logo) : null) ?? fallbackColor(a.title);
    return this.saveCover(who, { ...base, background: { kind: 'template', pattern, color } },
      { kind: 'template', pattern, photoId: null, aiAttempts, note: notes.join('／'), alt: altText(a.title, 'template') });
  }

  private async saveCover(who: ColumnViewer, input: CoverInput, cover: Omit<WebColumnCover, 'fileId'>): Promise<WebColumnCover> {
    const bytes = renderCover(input);
    const meta = await saveFile(this.deps.repo, this.deps.files, {
      tenantId: who.tenantId, ownerUserId: who.userId, name: 'column-cover.png', kind: 'png', bytes, origin: 'generated', runId: null,
    });
    return { fileId: meta.id, ...cover };
  }

  /** 会社のロゴ（PNG・JPEG）。無ければ `null`。 */
  private async logo(tenantId: string, fileId: string | null): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
    if (!fileId) return null;
    const meta = await this.deps.repo.getFile(tenantId, fileId).catch(() => null);
    if (!meta || (meta.kind !== 'png' && meta.kind !== 'jpeg')) return null;
    const bytes = await this.deps.files.get(tenantId, fileId);
    return bytes ? { bytes, mimeType: meta.mime } : null;
  }

  private async logoColor(tenantId: string, fileId: string, llm: LlmProvider, logo: { bytes: Uint8Array; mimeType: string }): Promise<string | null> {
    const key = `${tenantId}:${fileId}`;
    if (!this.colors.has(key)) this.colors.set(key, await brandColor(llm, logo));
    return this.colors.get(key) ?? null;
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

  // ---- 表現の決まり（第32.18.3節） --------------------------------------------

  /**
   * 当てる表現の決まりを AI に選び直させる（業種・分野・読み手・監修者を変えたとき）。秘書で直した後は選び直さない。
   *
   * @returns 選び直した後の設定
   */
  async refreshRules(tenantId: string, userId: string): Promise<WebColumnSettings> {
    const { repo } = this.deps;
    const settings = await repo.getTenantSettings(tenantId);
    const cur = settings.webColumns;
    if (cur.rulesBy === 'person') return cur;
    const rules = await inferRuleSets(await this.deps.llmFor(tenantId), {
      industry: cur.industry, topics: cur.topics, audience: cur.audience, supervisorTitle: cur.supervisor?.title ?? '',
      company: await this.companyName(tenantId, settings.company.legalName),
    });
    if (rules.join() === cur.rules.join()) return cur;
    const next = { ...cur, rules };
    await repo.saveTenantSettings(tenantId, 'webColumns', next, userId);
    await this.audit({ tenantId, userId }, 'column.rules', tenantId, { rules, by: 'ai' });
    return next;
  }

  /**
   * 表現の決まりを人が直す（秘書から。管理者だけ）。`auto` なら AI に任せる形に戻し、選び直す。
   *
   * @returns 直した後の決まり。直せなければ理由
   */
  async setRules(who: ColumnViewer, change: { add?: ColumnRuleSet[]; remove?: ColumnRuleSet[]; auto?: boolean }): Promise<{ rules: ColumnRuleSet[]; by: 'ai' | 'person' } | { error: string }> {
    const { repo } = this.deps;
    const user = await repo.findUserById(who.tenantId, who.userId);
    if (!user?.roles.includes('admin')) return { error: '表現の決まりを直せるのは管理者だけです' };
    const settings = await repo.getTenantSettings(who.tenantId);
    if (change.auto) {
      await repo.saveTenantSettings(who.tenantId, 'webColumns', { ...settings.webColumns, rulesBy: 'ai' }, who.userId);
      const next = await this.refreshRules(who.tenantId, who.userId);
      return { rules: next.rules, by: 'ai' };
    }
    const order: ColumnRuleSet[] = ['medical', 'health-products', 'legal'];
    const set = new Set(settings.webColumns.rules);
    for (const r of change.add ?? []) if (order.includes(r)) set.add(r);
    for (const r of change.remove ?? []) set.delete(r);
    const rules = order.filter((r) => set.has(r));
    await repo.saveTenantSettings(who.tenantId, 'webColumns', { ...settings.webColumns, rules, rulesBy: 'person' }, who.userId);
    await this.audit(who, 'column.rules', who.tenantId, { rules, by: 'person' });
    return { rules, by: 'person' };
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
      review, cover: next.cover === undefined ? cur.cover : next.cover, origin: next.origin, createdBy: who.userId,
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
      // 予定表の先回りと予約から入れるのは仕組み（ワーカー）が行う（第32.18.4節）
      id: randomUUID(), tenantId: who.tenantId, actorType: who.userId === 'system' ? 'system' : 'user', actorId: who.userId === 'system' ? 'column-watch' : who.userId,
      action, targetType: 'web_column', targetId: id,
      detail, occurredAt: new Date().toISOString(),
    });
  }
}

/** カバー画像の代わりの文。 */
function altText(title: string, kind: ColumnCoverKind): string {
  return kind === 'ai' ? `「${title}」のカバーの挿絵` : kind === 'photo' ? `「${title}」のカバーの写真` : `「${title}」のカバー`;
}

/** 自社の書き方（第15.2.1節）を、コラムを書く指示に渡す短い文にする。 */
function styleText(w: { selfReference: string; terms: { use: string; avoid: string }[]; notes: string }): string {
  return [
    w.selfReference ? `自社のことは「${w.selfReference}」と書く` : '',
    ...w.terms.map((t) => `「${t.avoid}」ではなく「${t.use}」と書く`),
    w.notes,
  ].filter(Boolean).join('。');
}
