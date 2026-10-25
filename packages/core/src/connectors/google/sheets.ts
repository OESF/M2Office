/**
 * @file Google スプレッドシートの接続口（仕様書 第14.3.4節「スプレッドシート」、第9.5.5.2節「表の作成の扱いとテンプレート」）。
 *
 * 作る表には見た目を付ける（見出しの行・1 行おきの塗り・見出しの固定・列の幅）。テンプレートからは見た目だけを写す（ADR-0111）。
 *
 * 権限は `drive.file` だけを使う（M2Office が作った表と、利用者が選んだ表だけ）。
 * **値は式として読ませない**（`valueInputOption=RAW`）。外から取った値に紛れた式（`=IMPORTXML(…)` など）で、
 * ほかのデータを取り出させないため（不変則 I-6）。数字だけの値は数として入れる。
 */

import type { ConnectorPrincipal, DriveFile, SheetsConnector } from '../types.js';
import { callGoogle, downloadGoogle, type GoogleApiEndpoints, type GoogleTokenSource } from './http.js';
import { FIELDS, MIME, toFile, type DriveMeta } from './drive.js';
import { lookRequests, readLook, type SheetLook } from './sheet-look.js';
import { SlideThemeUnavailableError } from '../../slides/theme.js';

/** 書き出しの上限（Google の書き出しの上限と同じ 10 MB）。 */
const EXPORT_MAX_BYTES = 10 * 1024 * 1024;
/** テンプレートの見た目を読む範囲（最初の表は上のほうにある）。 */
const LOOK_RANGE = 'A1:Z40';

/** 呼び出しに使うもの。接続口の組み立てより後に決まるため、呼ぶたびに引く。 */
type Ctx = () => { tokens: GoogleTokenSource; endpoints: GoogleApiEndpoints };

/** 数として入れる値。先頭が 0 の番号（`0012`）と、桁の多い番号（精度が落ちる）は文字のまま。 */
const NUMBER = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;

/**
 * 1 つの値を、入れる形にする。数字だけなら数、ほかは文字（式として読ませない）。
 *
 * @remarks `RAW` で送るので、文字は `=` で始まっても文字のまま入る
 */
export function toCell(v: string): string | number {
  return NUMBER.test(v) ? Number(v) : v;
}

/** シートの名前を範囲の書き方に入れる（`'` は `''` にして囲む）。 */
export const sheetRange = (title: string, a1: string) => `'${title.replace(/'/g, "''")}'!${a1}`;

/**
 * スプレッドシートの接続口を作る。
 *
 * @param ctx トークンと呼び先を返す
 */
export function googleSheets(ctx: Ctx): SheetsConnector {
  const sheets = (p: ConnectorPrincipal, path: string, init?: Parameters<typeof callGoogle>[4]) =>
    callGoogle(ctx().tokens, p, 'スプレッドシート', `${ctx().endpoints.sheets}${path}`, init);
  const drive = (p: ConnectorPrincipal, path: string, init?: Parameters<typeof callGoogle>[4]) =>
    callGoogle(ctx().tokens, p, 'ドライブ', `${ctx().endpoints.drive}${path}`, init);
  /** 見えるスプレッドシートの情報。見つからない・ごみ箱・スプレッドシートでなければ `null`。 */
  const meta = async (p: ConnectorPrincipal, id: string): Promise<DriveMeta | null> => {
    if (!id.trim()) return null;
    const f = (await drive(p, `/files/${encodeURIComponent(id)}?fields=${FIELDS}`)) as DriveMeta | null;
    return f && !f.trashed && f.mimeType === MIME.spreadsheet ? f : null;
  };
  const batch = (p: ConnectorPrincipal, id: string, requests: Record<string, unknown>[]): Promise<Record<string, any> | null> =>
    requests.length ? sheets(p, `/spreadsheets/${encodeURIComponent(id)}:batchUpdate`, { method: 'POST', body: { requests } }) : Promise.resolve({});
  /** 値を書く（式として読ませない）。 */
  const putValues = (p: ConnectorPrincipal, id: string, sheet: string, columns: string[], rows: string[][]) =>
    sheets(p, `/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(sheetRange(sheet, 'A1'))}?valueInputOption=RAW`, {
      method: 'PUT', body: { values: [columns, ...rows].map((r) => r.map(toCell)) },
    });
  /** シートの書式を読み、見た目にする（見出しの行と本文の行。読めなければ `null`）。 */
  const lookOf = async (p: ConnectorPrincipal, id: string, sheet: string): Promise<SheetLook | null> => {
    const q = new URLSearchParams({
      includeGridData: 'true', ranges: sheetRange(sheet, LOOK_RANGE),
      fields: 'sheets(data(rowData(values(formattedValue,effectiveFormat(backgroundColor,textFormat)))))',
    });
    const got = await sheets(p, `/spreadsheets/${encodeURIComponent(id)}?${q}`).catch(() => null);
    return readLook((got?.['sheets'] as { data?: { rowData?: Record<string, unknown>[] }[] }[] | undefined)?.[0]?.data?.[0]?.rowData);
  };
  /** シートの一覧（ID・名前・1 行おきの塗りの ID）。 */
  const sheetList = async (p: ConnectorPrincipal, id: string) => {
    const got = await sheets(p, `/spreadsheets/${encodeURIComponent(id)}?fields=${encodeURIComponent('sheets(properties(sheetId,title),bandedRanges(bandedRangeId))')}`);
    return ((got?.['sheets'] as { properties?: { sheetId?: number; title?: string }; bandedRanges?: { bandedRangeId?: number }[] }[] | undefined) ?? [])
      .map((s) => ({ sheetId: Number(s.properties?.sheetId ?? 0), title: String(s.properties?.title ?? ''), bandings: (s.bandedRanges ?? []).map((b) => Number(b.bandedRangeId)) }));
  };

  /** 最初のシートの名前。 */
  const firstSheet = async (p: ConnectorPrincipal, id: string): Promise<string | null> => {
    const res = await sheets(p, `/spreadsheets/${encodeURIComponent(id)}?fields=sheets.properties.title`);
    const title = (res?.['sheets'] as { properties?: { title?: string } }[] | undefined)?.[0]?.properties?.title;
    return typeof title === 'string' ? title : null;
  };

  return {
    create: async (p, s) => {
      // 入れるフォルダは先に確かめる（作ってから入れられないと、表だけが残る）
      if (s.folderId) {
        const folder = (await drive(p, `/files/${encodeURIComponent(s.folderId)}?fields=id,mimeType,trashed`)) as DriveMeta | null;
        if (!folder || folder.trashed || folder.mimeType !== MIME.folder) throw new Error('入れるフォルダが見つかりません');
      }
      const made = await sheets(p, '/spreadsheets?fields=spreadsheetId,spreadsheetUrl,sheets.properties(sheetId,title)', {
        method: 'POST', body: { properties: { title: s.title } },
      });
      const id = String(made?.['spreadsheetId'] ?? '');
      if (!id) throw new Error('スプレッドシートを作れませんでした');
      const first = (made?.['sheets'] as { properties?: { title?: string; sheetId?: number } }[] | undefined)?.[0]?.properties;
      const sheet = first?.title ?? 'Sheet1';
      await putValues(p, id, sheet, s.columns, s.rows);
      // 標準の見た目（見出しの行・1 行おきの塗り・見出しの固定・列の幅。第9.5.5.2節「表の作成の扱いとテンプレート」）。付けられなくても表は残す
      await batch(p, id, lookRequests(Number(first?.sheetId ?? 0), { columns: s.columns.length, rows: s.rows.length + 1 }, null)).catch(() => null);
      if (s.folderId) {
        const cur = (await drive(p, `/files/${id}?fields=parents`)) as { parents?: string[] } | null;
        const q = new URLSearchParams({ addParents: s.folderId, removeParents: (cur?.parents ?? []).join(','), fields: 'id' });
        await drive(p, `/files/${id}?${q}`, { method: 'PATCH', body: {} });
      }
      const file: DriveFile = {
        id, name: s.title, kind: 'spreadsheet', modifiedAt: new Date().toISOString(),
        url: typeof made?.['spreadsheetUrl'] === 'string' ? made['spreadsheetUrl'] : null,
      };
      return file;
    },

    read: async (p, s) => {
      const f = await meta(p, s.spreadsheetId);
      if (!f) return null;
      const sheet = await firstSheet(p, f.id);
      if (!sheet) return { file: toFile(f), values: [] };
      // 見出しの 1 行と、上限の行数まで。画面に表示されているとおりの文字で返す
      const range = sheetRange(sheet, `1:${Math.max(1, s.maxRows) + 1}`);
      const res = await sheets(p, `/spreadsheets/${encodeURIComponent(f.id)}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`);
      const values = ((res?.['values'] ?? []) as unknown[][]).map((r) => r.map((c) => String(c ?? '')));
      return { file: toFile(f), values };
    },

    export: async (p, id, format) => {
      const mime = format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf';
      try {
        const got = await downloadGoogle(ctx().tokens, p, 'ドライブ', `${ctx().endpoints.drive}/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(mime)}`, EXPORT_MAX_BYTES);
        if (!got) return null;
        return 'tooLarge' in got ? 'too-large' : got.bytes;
      } catch (err) {
        if (err instanceof Error && /exportSizeLimitExceeded/i.test(err.message)) return 'too-large';
        throw err;
      }
    },

    inspectTemplate: async (p, id) => {
      const f = (await drive(p, `/files/${encodeURIComponent(id)}?fields=${encodeURIComponent('name,mimeType,trashed,thumbnailLink')}`).catch(() => null)) as (DriveMeta & { thumbnailLink?: string }) | null;
      if (!f || f.trashed || f.mimeType !== MIME.spreadsheet) return null;
      let thumbnail: { bytes: Uint8Array; mimeType: string } | null = null;
      const link = f.thumbnailLink ?? '';
      if (/^https:\/\/(docs\.google\.com|[a-z0-9-]+\.googleusercontent\.com)\//.test(link)) {
        const got = await downloadGoogle(ctx().tokens, p, 'ドライブ', link, 2 * 1024 * 1024).catch(() => null);
        if (got && 'bytes' in got) thumbnail = { bytes: got.bytes, mimeType: 'image/png' };
      }
      return { name: (f.name ?? '').trim() || 'テンプレート', thumbnail };
    },

    createFromTemplate: async (p, s) => {
      let copied: Record<string, unknown> | null;
      try {
        copied = await drive(p, `/files/${encodeURIComponent(s.templateId)}/copy?fields=${FIELDS}`, { method: 'POST', body: { name: s.title } });
      } catch (err) {
        throw new SlideThemeUnavailableError(`テンプレート「${s.templateName}」のファイルを開けませんでした（${err instanceof Error ? err.message : String(err)}）`);
      }
      const made = copied as DriveMeta | null;
      if (!made?.id) throw new SlideThemeUnavailableError(`テンプレート「${s.templateName}」のファイルが見つかりませんでした（消されたか、共有が外れたかもしれません。選び直してください）`);
      try {
        // テンプレートの最初のシートから見た目を読み、表は新しいシートに書いて、見本のシートを消す
        const before = await sheetList(p, made.id);
        const look = before[0] ? await lookOf(p, made.id, before[0].title) : null;
        const title = before.some((x) => x.title === '表') ? `表（${new Date().toISOString().slice(0, 10)}）` : '表';
        const added = await batch(p, made.id, [{ addSheet: { properties: { title, index: 0 } } }]);
        const sheetId = Number((added?.['replies'] as { addSheet?: { properties?: { sheetId?: number } } }[] | undefined)?.[0]?.addSheet?.properties?.sheetId ?? 0);
        await putValues(p, made.id, title, s.columns, s.rows);
        await batch(p, made.id, [
          ...before.map((x) => ({ deleteSheet: { sheetId: x.sheetId } })),
          ...lookRequests(sheetId, { columns: s.columns.length, rows: s.rows.length + 1 }, look),
        ]);
      } catch (err) {
        // 書きかけを残さない（ごみ箱に移すだけ）
        await drive(p, `/files/${encodeURIComponent(made.id)}`, { method: 'PATCH', body: { trashed: true } }).catch(() => null);
        throw new Error(`テンプレートに表を書けませんでした: ${err instanceof Error ? err.message : String(err)}`);
      }
      return toFile(made);
    },

    rewrite: async (p, s) => {
      const f = await meta(p, s.spreadsheetId);
      if (!f) return null;
      const list = await sheetList(p, f.id);
      const first = list[0];
      if (!first) return null;
      // 今の表の見た目を読んでから、値と書式と 1 行おきの塗りを消して書き直す
      const look = await lookOf(p, f.id, first.title);
      await batch(p, f.id, [
        ...first.bandings.map((bandedRangeId) => ({ deleteBanding: { bandedRangeId } })),
        { updateCells: { range: { sheetId: first.sheetId }, fields: 'userEnteredValue,userEnteredFormat' } },
      ]);
      await putValues(p, f.id, first.title, s.columns, s.rows);
      await batch(p, f.id, lookRequests(first.sheetId, { columns: s.columns.length, rows: s.rows.length + 1 }, look));
      const renamed = (await drive(p, `/files/${encodeURIComponent(f.id)}?fields=${FIELDS}`, { method: 'PATCH', body: { name: s.title } }).catch(() => null)) as DriveMeta | null;
      return toFile(renamed ?? f);
    },

    append: async (p, s) => {
      const f = await meta(p, s.spreadsheetId);
      if (!f) return null;
      const sheet = await firstSheet(p, f.id);
      if (!sheet) return null;
      const q = new URLSearchParams({ valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' });
      const res = await sheets(p, `/spreadsheets/${encodeURIComponent(f.id)}/values/${encodeURIComponent(sheetRange(sheet, 'A1'))}:append?${q}`, {
        method: 'POST', body: { values: s.rows.map((r) => r.map(toCell)) },
      });
      const updated = Number((res?.['updates'] as { updatedRows?: number } | undefined)?.updatedRows ?? s.rows.length);
      return { appended: updated };
    },
  };
}
