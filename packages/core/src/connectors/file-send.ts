/**
 * @file 接続の業務に預けたファイル（画像など）を、相手の道具が示した送り先へ送る（仕様書 第48.8.1節、ADR-0149）。
 *
 * 推論はファイルのデータを持てない。相手の道具が画像を受け取るときは、ふつう「画像を上げる一時リンクを出す道具」と
 * 「上がった画像を番号で使う道具」に分かれ、リンクへのデータの送信は MCP の外（HTTP）で行う。そのデータの送信を M2Office が受け持つ。
 *
 * @remarks
 * 送り先の URL は相手の道具の答え（外から来た文）から来る（不変則 I-6）。預けたファイルを接続の外へ出さないよう、
 * 送り先は https で、その接続の MCP のサーバーと同じサイト（登録したドメイン）に限り、転送は受け付けない。
 */

import { checkOutboundUrl } from '../net/outbound.js';

/** 業務に預けたファイル 1 つ（子の業務の入力の `files`）。 */
export interface HandedFile {
  /** ファイルの置き場の印。 */
  fileId: string;
  /** 送るときのファイルの名前。 */
  name: string;
  /** ファイルの形（`image/png` など）。 */
  mimeType: string;
  /** 代わりの文（画像の内容）。 */
  alt?: string;
  /** 使い道（「記事のアイキャッチ画像」など）。推論に見せる。 */
  purpose: string;
}

/** 送る形。JSON（データは base64）・multipart/form-data・そのまま。 */
export type FileSendFormat = 'json' | 'multipart' | 'binary';

/** 1 回の業務で送れる回数の上限（第48.8.1節）。 */
export const FILE_SEND_MAX_PER_RUN = 20;
/** 送れる 1 つのファイルの大きさの上限（10 MB）。 */
export const FILE_SEND_MAX_BYTES = 10 * 1024 * 1024;
/** 道具の答えに返す、相手の応答の長さ。 */
const RESPONSE_LENGTH = 2000;

/** 3 段の名前で数える国の区切り（`example.co.jp` は `co.jp` までが区切り）。 */
const SECOND_LEVEL = new Set(['co', 'or', 'ne', 'ac', 'ad', 'ed', 'go', 'gr', 'lg', 'com', 'net', 'org', 'gov', 'edu']);

/**
 * ホストの「サイト」（登録したドメイン）。`mcp.example.jp` も `www.example.jp` も `example.jp` になる。
 *
 * @remarks 公開の区切りの一覧は持たず、国の 2 文字の区切りの下の `co`・`or` などだけを 3 段で数える
 */
export function siteOfHost(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, '').split('.');
  if (parts.length <= 2 || /^\d+$/.test(parts[parts.length - 1]!)) return parts.join('.');
  const tld = parts[parts.length - 1]!;
  const second = parts[parts.length - 2]!;
  const take = tld.length === 2 && SECOND_LEVEL.has(second) ? 3 : 2;
  return parts.slice(-take).join('.');
}

/**
 * 送り先が、その接続のサイトの https か（第48.8.1節の境界）。合わなければ理由、合えば `null`。
 *
 * @param serverUrl 接続の MCP のサーバーの URL
 */
export function fileSendTargetProblem(target: string, serverUrl: string): string | null {
  let to: URL;
  let server: URL;
  try { to = new URL(target); server = new URL(serverUrl); } catch { return '送り先の URL を読めません'; }
  const local = (h: string) => h === 'localhost' || h === '127.0.0.1' || h.endsWith('.localhost');
  // 開発のサーバー（localhost の MCP）だけは http を受け付ける（接続の登録と同じ決まり）
  if (to.protocol !== 'https:' && !(to.protocol === 'http:' && local(to.hostname) && local(server.hostname))) return '送り先は https だけです';
  if (siteOfHost(to.hostname) !== siteOfHost(server.hostname)) return `送り先は、この接続のサイト（${siteOfHost(server.hostname)}）だけです`;
  return null;
}

/** 送る形ごとの本文と見出し。 */
function bodyOf(file: HandedFile, bytes: Uint8Array, format: FileSendFormat, names: { filename?: string; mimeType?: string; data?: string; field?: string }): { body: BodyInit; headers: Record<string, string> } {
  if (format === 'json') {
    const json = {
      [names.filename || 'filename']: file.name,
      [names.mimeType || 'mimeType']: file.mimeType,
      [names.data || 'dataBase64']: Buffer.from(bytes).toString('base64'),
    };
    return { body: JSON.stringify(json), headers: { 'content-type': 'application/json' } };
  }
  if (format === 'multipart') {
    const form = new FormData();
    form.append(names.field || 'file', new Blob([new Uint8Array(bytes)], { type: file.mimeType }), file.name);
    return { body: form, headers: {} };
  }
  return { body: new Uint8Array(bytes), headers: { 'content-type': file.mimeType } };
}

/**
 * ファイルを送る。転送（3xx）は受け付けない（送り先を確かめた後に別の所へ移されないため）。
 *
 * @param fetchFn 送る口（試しで差し替える）。既定は `fetch`。送り先の確かめ（`checkOutboundUrl`）はこの関数が行う
 * @returns 相手の応答の番号と、始めの部分。送れなければ理由
 * @remarks 危険度: external-send（会社のファイルを社外に送る。送り先は、その接続のサイトに限る）
 */
export async function sendHandedFile(
  p: { file: HandedFile; bytes: Uint8Array; url: string; serverUrl: string; format: FileSendFormat; names?: { filename?: string; mimeType?: string; data?: string; field?: string } },
  fetchFn: typeof fetch = fetch,
): Promise<{ status: number; ok: boolean; response: string } | { error: string }> {
  const problem = fileSendTargetProblem(p.url, p.serverUrl);
  if (problem) return { error: problem };
  if (p.bytes.byteLength > FILE_SEND_MAX_BYTES) return { error: `ファイルが大きすぎます（${FILE_SEND_MAX_BYTES / 1024 / 1024} MB まで）` };
  const blocked = await checkOutboundUrl(p.url);
  if (blocked) return { error: blocked };
  const { body, headers } = bodyOf(p.file, p.bytes, p.format, p.names ?? {});
  try {
    const res = await fetchFn(p.url, { method: 'POST', body, headers, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    if (res.status >= 300 && res.status < 400) return { error: '送り先が別の所へ移すよう答えたため、送りませんでした' };
    const text = (await res.text().catch(() => '')).slice(0, RESPONSE_LENGTH);
    return { status: res.status, ok: res.ok, response: text };
  } catch (err) {
    return { error: `送れませんでした: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 子の業務の入力から、預けたファイルを読む（形の合わないものは除く）。 */
export function handedFilesOf(input: Record<string, unknown>): HandedFile[] {
  const raw = input['files'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((f): f is HandedFile => !!f && typeof f === 'object'
    && typeof (f as HandedFile).fileId === 'string' && typeof (f as HandedFile).name === 'string'
    && typeof (f as HandedFile).mimeType === 'string' && typeof (f as HandedFile).purpose === 'string');
}
