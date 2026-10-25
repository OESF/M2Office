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
import { clearBodyRequests, docBodyRequests, fillTableRequests, findMark, type DocContent } from './doc-requests.js';
import { SlideThemeUnavailableError } from '../../slides/theme.js';

/** 読む中身の大きさの上限（バイト）。これを超えるものは読まない。 */
export const DRIVE_READ_MAX_BYTES = 5 * 1024 * 1024;

/** そのままの形で読むときの上限（契約書の PDF など。第38.7節）。 */
export const DRIVE_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** 探すときに返す件数の上限。 */
const SEARCH_LIMIT_MAX = 50;

/** ファイルの情報のうち、使うもの。 */
/** Google の形式を書き出す形（そのままでは取り出せないため。第10.10.8節）。 */
const EXPORT_FILE: Record<string, string> = {
  'application/vnd.google-apps.document': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.google-apps.spreadsheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.google-apps.presentation': 'application/pdf',
};

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

    upload: async (p, input) => {
      // 本文は JSON の情報とファイルの中身を 1 つの multipart にまとめて送る（そのままの形で置く）
      const boundary = `m2office-${Math.random().toString(36).slice(2)}`;
      const metadata = { name: input.name, mimeType: input.mimeType, ...(input.parentId ? { parents: [input.parentId] } : {}) };
      const head = new TextEncoder().encode([
        `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(metadata),
        `--${boundary}`, `Content-Type: ${input.mimeType}`, '', '',
      ].join('\r\n'));
      const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
      const data = new Uint8Array(head.length + input.bytes.length + tail.length);
      data.set(head, 0);
      data.set(input.bytes, head.length);
      data.set(tail, head.length + input.bytes.length);
      const res = (await callGoogle(ctx().tokens, p, 'ドライブ', `${ctx().endpoints.driveUpload}/files?uploadType=multipart&fields=${FIELDS}`, {
        method: 'POST', raw: { contentType: `multipart/related; boundary=${boundary}`, data },
      })) as DriveMeta | null;
      if (!res) throw new Error('入れるフォルダが見つかりません');
      return toFile(res);
    },

    download: async (p, fileId) => {
      const f = await meta(p, fileId);
      if (!f || f.mimeType === MIME.folder) return null;
      // Google の形式は、そのままでは取り出せないため書き出す（ドキュメントは Word・スプレッドシートは Excel・スライドは PDF。第10.10.8節）
      const as = f.mimeType ? EXPORT_FILE[f.mimeType] : undefined;
      const url = as
        ? `${ctx().endpoints.drive}/files/${encodeURIComponent(f.id)}/export?mimeType=${encodeURIComponent(as)}`
        : `${ctx().endpoints.drive}/files/${encodeURIComponent(f.id)}?alt=media`;
      // 録音は 200 MB まで受け取る（第9.4.5節）。そのほかは文書の上限
      const max = f.mimeType?.startsWith('audio/') ? 200 * 1024 * 1024 : DRIVE_DOWNLOAD_MAX_BYTES;
      const got = await downloadGoogle(ctx().tokens, p, 'ドライブ', url, max);
      if (!got) return null;
      if ('tooLarge' in got) return { tooLarge: true as const };
      return { file: toFile(f), mimeType: as ?? f.mimeType ?? 'application/octet-stream', bytes: got.bytes };
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
  const docsApi = (p: ConnectorPrincipal, path: string, init?: Parameters<typeof callGoogle>[4]) =>
    callGoogle(ctx().tokens, p, 'ドキュメント', `${ctx().endpoints.docs}${path}`, init);
  const driveApi = (p: ConnectorPrincipal, path: string, init?: Parameters<typeof callGoogle>[4]) =>
    callGoogle(ctx().tokens, p, 'ドライブ', `${ctx().endpoints.drive}${path}`, init);
  const content = async (p: ConnectorPrincipal, id: string, fields: string): Promise<DocContent[] | null> => {
    const d = await docsApi(p, `/documents/${encodeURIComponent(id)}?fields=${encodeURIComponent(`body(content(${fields}))`)}`);
    return d ? ((d['body']?.['content'] as DocContent[] | undefined) ?? []) : null;
  };
  const batch = (p: ConnectorPrincipal, id: string, requests: Record<string, unknown>[]) =>
    requests.length ? docsApi(p, `/documents/${encodeURIComponent(id)}:batchUpdate`, { method: 'POST', body: { requests } }) : Promise.resolve({});
  /**
   * 本文を空にして、名前の付いたスタイルで書き入れる（第9.5.5.2節「文書のテンプレート」、ADR-0110）。表は印の段落を後から表に置き換える。
   *
   * @returns 書けたか（文書が見つからなければ `false`）
   */
  const writeBody = async (p: ConnectorPrincipal, id: string, markdown: string): Promise<boolean> => {
    const now = await content(p, id, 'startIndex,endIndex');
    if (!now) return false;
    const { requests, tables } = docBodyRequests(markdown);
    await batch(p, id, [...clearBodyRequests(now), ...requests]);
    const MARKED = 'startIndex,endIndex,paragraph(elements(textRun(content))),table(tableRows(tableCells(content(startIndex))))';
    // 後ろの表から置き換える（前の表の位置が動かないように）
    for (const t of [...tables].reverse()) {
      const before = await content(p, id, MARKED);
      const m = before ? findMark(before, t.mark) : null;
      if (!m) continue;
      const columns = Math.max(1, ...t.rows.map((r) => r.length));
      await batch(p, id, [
        { deleteContentRange: { range: { startIndex: m.start, endIndex: m.end } } },
        { insertTable: { rows: t.rows.length, columns, location: { index: m.start } } },
      ]);
      const after = await content(p, id, MARKED);
      const table = (after ?? []).filter((c) => c.table && (c.startIndex ?? 0) >= m.start).sort((a, b) => (a.startIndex ?? 0) - (b.startIndex ?? 0))[0];
      if (table) await batch(p, id, fillTableRequests(table, t.rows));
    }
    return true;
  };
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

    replace: async (p, d) => {
      if (!d.documentId.trim()) return null;
      const id = encodeURIComponent(d.documentId);
      const f = (await callGoogle(ctx().tokens, p, 'ドライブ', `${ctx().endpoints.drive}/files/${id}?fields=${FIELDS}`)) as DriveMeta | null;
      if (!f || f.trashed || f.mimeType !== MIME.document) return null;
      // 本文を HTML にして、同じファイルに取り込ませ直す（URL と共有はそのまま。前の形は版の履歴に残る）
      const boundary = `m2office-${Math.random().toString(36).slice(2)}`;
      const body = [
        `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify({ name: d.title }),
        `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', '', markdownToDocHtml(d.body),
        `--${boundary}--`, '',
      ].join('\r\n');
      const res = (await callGoogle(ctx().tokens, p, 'ドキュメント', `${ctx().endpoints.driveUpload}/files/${id}?uploadType=multipart&fields=${FIELDS}`, {
        method: 'PATCH', raw: { contentType: `multipart/related; boundary=${boundary}`, data: body },
      })) as DriveMeta | null;
      return res ? toFile(res) : null;
    },

    inspectTemplate: async (p, id) => {
      const f = (await driveApi(p, `/files/${encodeURIComponent(id)}?fields=${encodeURIComponent('name,mimeType,trashed,thumbnailLink')}`).catch(() => null)) as (DriveMeta & { thumbnailLink?: string }) | null;
      if (!f || f.trashed || f.mimeType !== MIME.document) return null;
      // 見本の縮小の絵。Google の縮小の絵の道（本人のトークンで読む）だけを読む
      let thumbnail: { bytes: Uint8Array; mimeType: string } | null = null;
      const link = f.thumbnailLink ?? '';
      if (/^https:\/\/(docs\.google\.com|[a-z0-9-]+\.googleusercontent\.com)\//.test(link)) {
        const got = await downloadGoogle(ctx().tokens, p, 'ドライブ', link, 2 * 1024 * 1024).catch(() => null);
        if (got && 'bytes' in got) thumbnail = { bytes: got.bytes, mimeType: 'image/png' };
      }
      return { name: (f.name ?? '').trim() || 'テンプレート', thumbnail };
    },

    createFromTemplate: async (p, d) => {
      let copied: Record<string, unknown> | null;
      try {
        copied = await driveApi(p, `/files/${encodeURIComponent(d.templateId)}/copy?fields=${FIELDS}`, { method: 'POST', body: { name: d.title } });
      } catch (err) {
        throw new SlideThemeUnavailableError(`テンプレート「${d.templateName}」のファイルを開けませんでした（${err instanceof Error ? err.message : String(err)}）`);
      }
      const made = copied as DriveMeta | null;
      if (!made?.id) throw new SlideThemeUnavailableError(`テンプレート「${d.templateName}」のファイルが見つかりませんでした（消されたか、共有が外れたかもしれません。選び直してください）`);
      try {
        await writeBody(p, made.id, d.body);
      } catch (err) {
        // 書きかけを残さない（ごみ箱に移すだけ）
        await driveApi(p, `/files/${encodeURIComponent(made.id)}`, { method: 'PATCH', body: { trashed: true } }).catch(() => null);
        throw new Error(`テンプレートに本文を書き入れられませんでした: ${err instanceof Error ? err.message : String(err)}`);
      }
      return toFile(made);
    },

    rewrite: async (p, d) => {
      if (!d.documentId.trim()) return null;
      const id = encodeURIComponent(d.documentId);
      const f = (await driveApi(p, `/files/${id}?fields=${FIELDS}`)) as DriveMeta | null;
      if (!f || f.trashed || f.mimeType !== MIME.document) return null;
      if (!(await writeBody(p, d.documentId, d.body))) return null;
      const renamed = (await driveApi(p, `/files/${id}?fields=${FIELDS}`, { method: 'PATCH', body: { name: d.title } }).catch(() => null)) as DriveMeta | null;
      return toFile(renamed ?? f);
    },

    export: async (p, documentId, format) => {
      const mime = format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf';
      try {
        const got = await downloadGoogle(ctx().tokens, p, 'ドライブ', `${ctx().endpoints.drive}/files/${encodeURIComponent(documentId)}/export?mimeType=${encodeURIComponent(mime)}`, EXPORT_MAX_BYTES);
        if (!got) return null;
        return 'tooLarge' in got ? 'too-large' : got.bytes;
      } catch (err) {
        // Google の書き出しの上限（10 MB）を超えたとき
        if (err instanceof Error && /exportSizeLimitExceeded/i.test(err.message)) return 'too-large';
        throw err;
      }
    },
  };
}

/** Word・PDF の書き出しの上限（Google の書き出しの上限と同じ 10 MB）。 */
const EXPORT_MAX_BYTES = 10 * 1024 * 1024;
