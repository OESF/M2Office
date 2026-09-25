/**
 * @file Google スプレッドシートの接続口（仕様書 第14.3.4節「スプレッドシート」）。
 *
 * 権限は `drive.file` だけを使う（M2Office が作った表と、利用者が選んだ表だけ）。
 * **値は式として読ませない**（`valueInputOption=RAW`）。外から取った値に紛れた式（`=IMPORTXML(…)` など）で、
 * ほかのデータを取り出させないため（不変則 I-6）。数字だけの値は数として入れる。
 */

import type { ConnectorPrincipal, DriveFile, SheetsConnector } from '../types.js';
import { callGoogle, type GoogleApiEndpoints, type GoogleTokenSource } from './http.js';
import { FIELDS, MIME, toFile, type DriveMeta } from './drive.js';

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
      const made = await sheets(p, '/spreadsheets?fields=spreadsheetId,spreadsheetUrl,sheets.properties.title', {
        method: 'POST', body: { properties: { title: s.title } },
      });
      const id = String(made?.['spreadsheetId'] ?? '');
      if (!id) throw new Error('スプレッドシートを作れませんでした');
      const sheet = (made?.['sheets'] as { properties?: { title?: string } }[] | undefined)?.[0]?.properties?.title ?? 'Sheet1';
      const values = [s.columns, ...s.rows].map((r) => r.map(toCell));
      await sheets(p, `/spreadsheets/${id}/values/${encodeURIComponent(sheetRange(sheet, 'A1'))}?valueInputOption=RAW`, {
        method: 'PUT', body: { values },
      });
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
