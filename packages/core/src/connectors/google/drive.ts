/**
 * @file Google ドライブとドキュメントの接続口（仕様書 第14.3.4節「ドライブ」「ドキュメント」）。
 *
 * 権限は `drive.file` だけを使う。見えるのは M2Office が作ったファイルと、利用者が選んだファイルだけで、
 * ドライブ全体は見ない。共有は指定した人にだけ行い、「リンクを知っている全員」への公開は作らない。
 */

import type { ConnectorPrincipal, DocsConnector, DriveConnector, DriveFile } from '../types.js';
import { extractPdfText } from '../../files/pdf.js';
import { callGoogle, downloadGoogle, type GoogleApiEndpoints, type GoogleTokenSource } from './http.js';
import { markdownToDocHtml } from './doc-html.js';

/** 読む中身の大きさの上限（バイト）。これを超えるものは読まない。 */
export const DRIVE_READ_MAX_BYTES = 5 * 1024 * 1024;

/** 探すときに返す件数の上限。 */
const SEARCH_LIMIT_MAX = 50;

/** ファイルの情報のうち、使うもの。 */
export const FIELDS = 'id,name,mimeType,modifiedTime,webViewLink,trashed';

export const MIME = {
  document: 'application/vnd.google-apps.document',
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
  presentation: 'application/vnd.google-apps.presentation',
  form: 'application/vnd.google-apps.form',
  folder: 'application/vnd.google-apps.folder',
  pdf: 'application/pdf',
} as const;

/** Drive API が返すファイルの情報。 */
export interface DriveMeta {
  id: string; name?: string; mimeType?: string; modifiedTime?: string; webViewLink?: string; trashed?: boolean;
}

/** 種類を M2Office の分け方にする。 */
export function kindOf(mimeType: string | undefined): DriveFile['kind'] {
  const hit = (Object.entries(MIME) as [DriveFile['kind'], string][]).find(([, m]) => m === mimeType);
  return hit ? hit[0] : 'other';
}

export const toFile = (f: DriveMeta): DriveFile => ({
  id: f.id, name: f.name ?? '', kind: kindOf(f.mimeType), modifiedAt: f.modifiedTime ?? '', url: f.webViewLink ?? null,
});

/** 検索の条件の文字列の中に入れる値。`\` と `'` を逃がす（Drive の検索の書き方）。 */
export const quoteDriveQuery = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** 呼び出しに使うもの。接続口の組み立てより後に決まるため、呼ぶたびに引く。 */
type Ctx = () => { tokens: GoogleTokenSource; endpoints: GoogleApiEndpoints };

/**
 * ドライブの接続口を作る。
 *
 * @param ctx トークンと呼び先を返す
 */
export function googleDrive(ctx: Ctx): DriveConnector {
  const api = (p: ConnectorPrincipal, path: string, init?: Parameters<typeof callGoogle>[4]) =>
    callGoogle(ctx().tokens, p, 'ドライブ', `${ctx().endpoints.drive}${path}`, init);
  const download = (p: ConnectorPrincipal, path: string) =>
    downloadGoogle(ctx().tokens, p, 'ドライブ', `${ctx().endpoints.drive}${path}`, DRIVE_READ_MAX_BYTES);
  /** 見えるファイルの情報。見つからない・ごみ箱なら `null`。 */
  const meta = async (p: ConnectorPrincipal, fileId: string): Promise<DriveMeta | null> => {
    if (!fileId.trim()) return null;
    const f = (await api(p, `/files/${encodeURIComponent(fileId)}?fields=${FIELDS}`)) as DriveMeta | null;
    return f && !f.trashed ? f : null;
  };

  return {
    search: async (p, q) => {
      const words = q.query.trim();
      const params = new URLSearchParams({
        q: `trashed = false${words ? ` and name contains ${quoteDriveQuery(words)}` : ''}`,
        orderBy: 'modifiedTime desc',
        pageSize: String(Math.min(Math.max(q.limit ?? 20, 1), SEARCH_LIMIT_MAX)),
        fields: `files(${FIELDS})`,
      });
      const res = await api(p, `/files?${params}`);
      return ((res?.['files'] ?? []) as DriveMeta[]).map(toFile);
    },

    read: async (p, fileId) => {
      const f = await meta(p, fileId);
      if (!f || f.mimeType === MIME.folder) return null;
      const file = toFile(f);
      const id = encodeURIComponent(f.id);
      // Google の形式は書き出して読む。スプレッドシートは最初のシートだけが書き出される（Google の仕様）
      const exportAs: Record<string, string> = {
        [MIME.document]: 'text/plain', [MIME.presentation]: 'text/plain', [MIME.spreadsheet]: 'text/tab-separated-values',
      };
      const as = f.mimeType ? exportAs[f.mimeType] : undefined;
      const readable = !!as || f.mimeType === MIME.pdf || /^text\//.test(f.mimeType ?? '');
      if (!readable) {
        const why = f.mimeType === MIME.form
          ? 'フォームは文字で読めません。回答は「フォームの回答を読む」操作で読みます'
          : `この種類のファイル（${f.mimeType ?? '不明'}）は文字で読めません`;
        return { file, text: `（${why}）` };
      }
      const got = as
        ? await download(p, `/files/${id}/export?mimeType=${encodeURIComponent(as)}`)
        : await download(p, `/files/${id}?alt=media`);
      if (!got) return null;
      if ('tooLarge' in got) return { file, text: `（ファイルが大きすぎるため読みませんでした。${DRIVE_READ_MAX_BYTES / 1024 / 1024} MB までです）` };
      if (f.mimeType === MIME.pdf) {
        const pdf = await extractPdfText(got.bytes);
        const text = pdf.pages.map((pg) => pg.text).join('\n\n').trim();
        const note = pdf.textlessPages.length > 0 ? `\n\n（文字を取り出せなかったページ: ${pdf.textlessPages.join('・')}）` : '';
        return { file, text: `${text}${note}` };
      }
      // 書き出しの先頭に付くことがある BOM は除く
      return { file, text: new TextDecoder('utf-8').decode(got.bytes).replace(/^﻿/, '') };
    },

    createFolder: async (p, input) => {
      const res = (await api(p, `/files?fields=${FIELDS}`, {
        method: 'POST',
        body: { name: input.name, mimeType: MIME.folder, ...(input.parentId ? { parents: [input.parentId] } : {}) },
      })) as DriveMeta | null;
      if (!res) throw new Error('親のフォルダが見つかりません');
      return toFile(res);
    },

    get: async (p, fileId) => {
      const f = await meta(p, fileId);
      return f ? toFile(f) : null;
    },

    shareWithDomain: async (p, s) => {
      const f = await meta(p, s.fileId);
      if (!f) return null;
      // 会社のドメインの全員に閲覧だけ。検索には出さない（allowFileDiscovery: false）。リンクによる一般公開ではない
      await api(p, `/files/${encodeURIComponent(f.id)}/permissions?sendNotificationEmail=false&fields=id`, {
        method: 'POST', body: { type: 'domain', role: 'reader', domain: s.domain, allowFileDiscovery: false },
      });
      return { fileId: f.id, domain: s.domain };
    },

    share: async (p, s) => {
      // 見えないファイル（M2Office が作っていないもの）は共有しない。drive.file の範囲なので、Google からも見えない
      const f = await meta(p, s.fileId);
      if (!f) return null;
      const sharedWith: string[] = [];
      for (const email of s.emails.map((e) => e.trim()).filter(Boolean)) {
        // 指定した人にだけ。リンクによる公開（type: anyone）は作らない（仕様書 第9.4.4節）
        await api(p, `/files/${encodeURIComponent(f.id)}/permissions?sendNotificationEmail=true&fields=id`, {
          method: 'POST', body: { type: 'user', role: s.role, emailAddress: email },
        });
        sharedWith.push(email);
      }
      return { fileId: f.id, sharedWith };
    },
  };
}

/**
 * ドキュメントの接続口を作る。
 *
 * @param ctx トークンと呼び先を返す
 */
export function googleDocs(ctx: Ctx): DocsConnector {
  return {
    create: async (p, d) => {
      // 本文を HTML にして取り込ませ、見出しや箇条書きをドキュメントの書式にする
      const boundary = `m2office-${Math.random().toString(36).slice(2)}`;
      const metadata = { name: d.title, mimeType: MIME.document, ...(d.folderId ? { parents: [d.folderId] } : {}) };
      const body = [
        `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(metadata),
        `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', '', markdownToDocHtml(d.body),
        `--${boundary}--`, '',
      ].join('\r\n');
      const res = (await callGoogle(ctx().tokens, p, 'ドキュメント', `${ctx().endpoints.driveUpload}/files?uploadType=multipart&fields=${FIELDS}`, {
        method: 'POST', raw: { contentType: `multipart/related; boundary=${boundary}`, data: body },
      })) as DriveMeta | null;
      if (!res) throw new Error('入れるフォルダが見つかりません');
      return toFile(res);
    },

    append: async (p, d) => {
      if (!d.documentId.trim()) return null;
      const id = encodeURIComponent(d.documentId);
      const f = (await callGoogle(ctx().tokens, p, 'ドライブ', `${ctx().endpoints.drive}/files/${id}?fields=${FIELDS}`)) as DriveMeta | null;
      // 文書でないもの・ごみ箱のものには追記しない
      if (!f || f.trashed || f.mimeType !== MIME.document) return null;
      // 末尾に書き足す。追記の仕組みは書式を受けないため、文をそのまま入れる
      const res = await callGoogle(ctx().tokens, p, 'ドキュメント', `${ctx().endpoints.docs}/documents/${id}:batchUpdate`, {
        method: 'POST', body: { requests: [{ insertText: { endOfSegmentLocation: {}, text: `\n${d.text}` } }] },
      });
      return res ? { documentId: f.id } : null;
    },
  };
}
