/**
 * @file 資料の OKF での書き出し（仕様書 第44.16節。段 4）と、古い版の知らせ（第44.8節。段 3）。
 *
 * - OKF は整理の道具ではなく、持ち出しの形式（第11.10節）。目録を内部の正とし、変換して書き出す（第11.10.3節）
 * - 本人が入れたときだけ、本人のドライブの「M2Office 資料/OKF」に、資料 1 つを Markdown 1 つにして書き出す。**本体と全文は入れない**（要約とリンク）
 * - 入れたらすぐに書き出し、その後は週に 1 回、変わったものだけを書き直す。消した資料のファイルはごみ箱へ移す。自動で共有しない
 * - 項目の形は OKF v0.2 の SPEC.md に合わせる（`generated` は `{ by, at }`、`verified` は人が確かめたときだけ、`sources` は `resource` を持つ並び）
 * - メールから来た資料も送り主を書かない。人の名前を書かない（`verified` の `by` は `human:owner`）
 * - 古い版の知らせ: 題名・取引先・種類が同じで中身が違う資料を同じ資料の版とみなし、新しく見つかった組の数を週 1 回本人に知らせる（自動では消さない）
 *
 * @see 仕様書 第44.8節・第44.16節・第11.10節
 */

import { createHash, randomUUID } from 'node:crypto';
import { LIBRARY_OKF_INTERVAL_MS, libraryTitleOf, type LibraryItem, type LibraryOkfState } from '@m2office/shared';
import { ConnectorUnavailableError, type DriveConnector } from '../connectors/types.js';
import type { Logger } from '../log/logger.js';
import type { Repository } from '../repository/types.js';
import type { LibraryService } from './service.js';
import { libraryVersionKey, type LibraryOwnerStateRow, type LibraryStore, type LibraryViewer } from './store.js';

/** OKF の版（最上位の `index.md` に書く）。 */
export const LIBRARY_OKF_VERSION = '0.2';
/** 整理した M2Office を表す OKF の書き手（モデル名は書かない。第44.16節）。 */
const OKF_GENERATED_BY = 'process:m2office-library';
/** 1 回の見回りで書くファイルの数の上限（残りは次の回）。 */
const OKF_WRITES_PER_RUN = 100;
/** 版の知らせを見直す間隔（週に 1 回）。 */
const VERSIONS_INTERVAL_MS = 7 * 86_400_000;
/** 1 社を見直す間隔（目録を読む回数を抑える）。 */
const TENANT_INTERVAL_MS = 10 * 60_000;
const MIME = 'text/markdown';

/** YAML の文字（JSON の文字は YAML の二重引用符の文字として読める）。 */
const q = (s: string) => JSON.stringify(s);

/**
 * 資料 1 つのファイル名。題名と資料の ID の一部（予約の名前 `index.md`・`log.md` にならない）。
 */
export function libraryOkfFileName(item: Pick<LibraryItem, 'id' | 'title' | 'originalName'>): string {
  const base = libraryTitleOf(item).replace(/[\u0000-\u001f\\/:*?"<>|#[\]^]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || '資料';
  return `${base} (${item.id.replace(/^lib-/, '').slice(0, 8)}).md`;
}

/**
 * 資料 1 つを OKF の文書にする（第44.16節）。
 *
 * @remarks 本体と全文は入れない。メールの送り主と人の名前は書かない。`status`・`stale_after` は確かでないので入れない
 */
export function libraryOkfDocument(item: LibraryItem): string {
  const title = libraryTitleOf(item);
  const tags = [...new Set([item.counterparty, ...item.keywords].map((t) => t.trim()).filter(Boolean))].slice(0, 20);
  const verifiedAt = item.verifiedAt ?? (item.edited.length > 0 ? item.updatedAt : null);
  const head = [
    '---',
    `type: ${q(item.docType || '資料')}`,
    `title: ${q(title)}`,
    ...(item.summary ? [`description: ${q(item.summary)}`] : []),
    ...(item.driveUrl ? [`resource: ${q(item.driveUrl)}`] : []),
    ...(tags.length ? [`tags: [${tags.map(q).join(', ')}]`] : []),
    `generated: { by: ${q(OKF_GENERATED_BY)}, at: ${q(item.updatedAt)} }`,
    ...(verifiedAt ? [`verified: { by: ${q('human:owner')}, at: ${q(verifiedAt)} }`] : []),
    ...(item.driveUrl ? [
      'sources:',
      `  - id: ${q('original')}`,
      `    resource: ${q(item.driveUrl)}`,
      `    title: ${q(item.originalName)}`,
      `    last_modified: ${q(item.receivedAt)}`,
    ] : []),
    '---',
  ];
  const line = (label: string, value: string | null) => (value ? [`- ${label}: ${value}`] : []);
  const body = [
    `# ${title}`,
    '',
    ...(item.summary ? [item.summary, ''] : []),
    ...(item.driveUrl ? [`- 元の資料: [${item.originalName.replace(/[[\]]/g, '')}](${item.driveUrl})`] : [`- 元の資料: ${item.originalName}`]),
    ...line('種類', item.docType),
    ...line('取引先', item.counterparty),
    ...line('書類の日付', item.docDate),
    `- 受け取った日: ${item.receivedAt.slice(0, 10)}`,
    '',
  ];
  return [...head, ...body].join('\n');
}

/** 最上位の一覧（`index.md`。OKF の版と、種類ごとの一覧）。 */
export function libraryOkfIndex(items: LibraryItem[]): string {
  const byType = new Map<string, LibraryItem[]>();
  for (const i of items) {
    const t = i.docType || '資料';
    byType.set(t, [...(byType.get(t) ?? []), i]);
  }
  const out = ['---', `okf_version: ${q(LIBRARY_OKF_VERSION)}`, '---', '# M2Office 資料', ''];
  for (const [t, list] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
    out.push(`## ${t}`, '');
    for (const i of list) out.push(`* [${libraryTitleOf(i).replace(/[[\]]/g, '')}](${encodeURI(libraryOkfFileName(i))})${i.summary ? ` - ${i.summary.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`);
    out.push('');
  }
  return out.join('\n');
}

const digestOf = (s: string) => createHash('sha256').update(s).digest('hex');

/** 書き出しと知らせに渡すもの。 */
export interface LibraryKeeperDeps {
  service: LibraryService;
  store: LibraryStore;
  drive: DriveConnector;
  repo: Pick<Repository, 'appendAudit' | 'createNotification' | 'findUserById' | 'getUserSettings'>;
  /** 会社が資料を使っていて、本人が利用範囲の中か。 */
  access(tenantId: string, userId: string): Promise<unknown>;
  logger: Logger;
  now?(): Date;
}

/** 何もしていない人の様子。 */
const EMPTY: LibraryOwnerStateRow = { okfEnabled: false, okfWrittenAt: null, okfError: '', versionsNotified: [], versionsNoticedAt: null };

/**
 * OKF の書き出しと、古い版の知らせ（第44.16節・第44.8節）。ワーカー（見本の会社は API）が {@link LibraryKeeper.tick} を呼ぶ。
 */
export class LibraryKeeper {
  /** 会社ごとに最後に見直した時刻（目録を読む回数を抑える）。 */
  private readonly lastTenantRun = new Map<string, number>();

  constructor(private readonly deps: LibraryKeeperDeps) {}

  private now() { return this.deps.now?.() ?? new Date(); }

  /** 本人の OKF の書き出しの様子。 */
  async okfState(who: LibraryViewer): Promise<LibraryOkfState> {
    const w = await this.deps.store.ownerState(who.tenantId, who.userId);
    const files = (await this.deps.store.okfFiles(who.tenantId, who.userId)).filter((f) => f.key !== 'index').length;
    return { enabled: w?.okfEnabled ?? false, writtenAt: w?.okfWrittenAt ?? null, files, error: w?.okfError ?? '' };
  }

  /**
   * 本人が OKF の書き出しを入れる・切る（第44.16節）。入れたら、次の見回りですぐに書き出す。切っても、書き出したファイルは本人のドライブに残る。
   *
   * @remarks 危険度: 本人のドライブに書くだけ。共有しない
   */
  async setOkf(who: LibraryViewer, enabled: boolean): Promise<LibraryOkfState> {
    const cur = (await this.deps.store.ownerState(who.tenantId, who.userId)) ?? EMPTY;
    if (cur.okfEnabled !== enabled) {
      await this.deps.store.saveOwnerState(who.tenantId, who.userId, { ...cur, okfEnabled: enabled, okfWrittenAt: enabled ? null : cur.okfWrittenAt, okfError: '' });
      this.lastTenantRun.delete(who.tenantId);
      await this.deps.repo.appendAudit({
        id: randomUUID(), tenantId: who.tenantId, actorType: 'user', actorId: who.userId, action: enabled ? 'library.okf.on' : 'library.okf.off',
        targetType: 'library_okf', targetId: who.userId, detail: {}, occurredAt: this.now().toISOString(),
      });
    }
    return this.okfState(who);
  }

  /**
   * 見回り 1 回分。会社ごとに、資料を持つ人の古い版を知らせ、OKF の書き出しを入れた人の書き出しを進める。
   *
   * @param tenantIds 資料を使っている会社
   * @returns 書いたファイルの数
   */
  async tick(tenantIds: string[]): Promise<number> {
    let written = 0;
    const now = this.now().getTime();
    for (const tenantId of tenantIds) {
      const last = this.lastTenantRun.get(tenantId) ?? 0;
      if (now - last < TENANT_INTERVAL_MS) continue;
      this.lastTenantRun.set(tenantId, now);
      for (const ownerId of await this.deps.store.owners(tenantId)) {
        try {
          if (!(await this.deps.access(tenantId, ownerId))) continue;
          const state = (await this.deps.store.ownerState(tenantId, ownerId)) ?? EMPTY;
          const next = { ...state };
          const okfDue = next.okfEnabled && (!next.okfWrittenAt || now - Date.parse(next.okfWrittenAt) >= LIBRARY_OKF_INTERVAL_MS);
          const versionsDue = !next.versionsNoticedAt || now - Date.parse(next.versionsNoticedAt) >= VERSIONS_INTERVAL_MS;
          if (!okfDue && !versionsDue) continue;
          const items = await this.deps.store.allOf(tenantId, ownerId);
          if (versionsDue) await this.noticeVersions({ tenantId, userId: ownerId }, items, next);
          if (okfDue) written += await this.writeOkf({ tenantId, userId: ownerId }, items, next);
          await this.deps.store.saveOwnerState(tenantId, ownerId, next);
          // 書き残しがあれば、次の回にすぐ続きを書く
          if (okfDue && !next.okfWrittenAt) this.lastTenantRun.delete(tenantId);
        } catch (err) {
          this.deps.logger.warn('資料の書き出しか古い版の知らせに失敗しました', { tenantId, err: err instanceof Error ? err.name : 'unknown' });
        }
      }
    }
    return written;
  }

  /** 古い版の知らせ（第44.8節）。新しく見つかった組だけを数える。 */
  private async noticeVersions(who: LibraryViewer, items: LibraryItem[], state: LibraryOwnerStateRow): Promise<void> {
    const groups = new Map<string, LibraryItem[]>();
    for (const i of items) {
      const key = libraryVersionKey(i);
      if (key) groups.set(key, [...(groups.get(key) ?? []), i]);
    }
    const known = new Set(state.versionsNotified);
    const fresh = [...groups.entries()].filter(([k, list]) => list.length > 1 && !known.has(k));
    state.versionsNoticedAt = this.now().toISOString();
    if (fresh.length === 0) return;
    state.versionsNotified = [...state.versionsNotified, ...fresh.map(([k]) => k)];
    const user = await this.deps.repo.findUserById(who.tenantId, who.userId).catch(() => null);
    if (!user || user.status !== 'active') return;
    const prefs = await this.deps.repo.getUserSettings(who.tenantId, who.userId).catch(() => null);
    if (prefs?.notifications.kinds.library === false) return;
    const names = fresh.slice(0, 5).map(([, list]) => `・${libraryTitleOf(list[0]!)}（${list.length} 件）`);
    await this.deps.repo.createNotification({
      id: randomUUID(), tenantId: who.tenantId, userId: who.userId, kind: 'library', runId: null, readAt: null, createdAt: this.now().toISOString(),
      title: `同じ資料の版が ${fresh.length} 組見つかりました`,
      body: [...names, ...(fresh.length > 5 ? [`ほか ${fresh.length - 5} 組`] : []), '古いものは資料を開いて「ほかの版」から確かめられます'].join('\n').slice(0, 400),
    });
  }

  /** OKF の書き出し（第44.16節）。変わったものだけを書き直し、消した資料のファイルはごみ箱へ移す。 */
  private async writeOkf(who: LibraryViewer, items: LibraryItem[], state: LibraryOwnerStateRow): Promise<number> {
    const { store, drive } = this.deps;
    let writes = 0;
    try {
      const folder = await this.deps.service.okfFolder(who);
      const files = new Map((await store.okfFiles(who.tenantId, who.userId)).map((f) => [f.key, f]));
      const put = async (key: string, name: string, text: string): Promise<boolean> => {
        const digest = digestOf(`${name}\n${text}`);
        const cur = files.get(key);
        if (cur?.digest === digest) return true;
        if (writes >= OKF_WRITES_PER_RUN) return false;
        const bytes = new TextEncoder().encode(text);
        const replaced = cur ? await drive.replace(who, cur.driveId, { mimeType: MIME, bytes }) : null;
        // 名前が変わったか、ファイルが無くなっていれば作り直す
        let driveId = replaced?.id ?? null;
        if (replaced && cur && replaced.name !== name) {
          await drive.trash(who, cur.driveId).catch(() => false);
          driveId = null;
        }
        if (!driveId) driveId = (await drive.upload(who, { name, mimeType: MIME, bytes, parentId: folder })).id;
        await store.saveOkfFile(who.tenantId, who.userId, { key, driveId, digest });
        writes += 1;
        return true;
      };
      let complete = true;
      for (const item of items) {
        if (!(await put(item.id, libraryOkfFileName(item), libraryOkfDocument(item)))) complete = false;
      }
      // 消した資料のファイルはごみ箱へ（元に戻せる）
      const alive = new Set(items.map((i) => i.id));
      for (const [key, f] of files) {
        if (key === 'index' || alive.has(key)) continue;
        await drive.trash(who, f.driveId).catch(() => false);
        await store.deleteOkfFile(who.tenantId, who.userId, key);
      }
      if (!(await put('index', 'index.md', libraryOkfIndex(items)))) complete = false;
      state.okfError = '';
      if (complete) state.okfWrittenAt = this.now().toISOString();
    } catch (err) {
      state.okfError = err instanceof ConnectorUnavailableError ? err.message : 'Google ドライブに書き出せませんでした';
      // 読めない状態のまま続けて試さないよう、書き出した日時を進める（次は週に 1 回）
      state.okfWrittenAt = this.now().toISOString();
    }
    return writes;
  }

}
