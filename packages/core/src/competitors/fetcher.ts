/**
 * @file 公開の Web ページを読む口（競合の分析。仕様書 第36.7節・第36.13節）。
 *
 * 社外の公開のページだけを読む。**社内のネットワーク・自分自身・クラウドの管理用のアドレスには、つなぐ瞬間に断る**
 * （名前を引いた後に行き先を変える手口に備え、接続の時に引いたアドレスを確かめる）。転送は 3 回まで、毎回確かめ直す。
 * 名乗り（User-Agent）を付け、15 秒・2 MB で打ち切る。HTML と文字のページだけを受け取る。
 * 開発の見本の会社では、外に出ない見本の口（{@link MockPageFetcher}）を使う。
 */

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

/** 読んだページ。 */
export interface FetchedPage {
  /** 最後に着いた URL（転送の後） */
  url: string;
  status: number;
  contentType: string;
  text: string;
}

/** ページを読む口。 */
export interface PageFetcher {
  /**
   * ページを読む。届かなければ例外（{@link FetchError}）。
   *
   * @param accept 受け取る種類（`html` は HTML と文字、`text` は文字だけ。robots.txt は `text`）
   */
  get(url: string, accept: 'html' | 'text'): Promise<FetchedPage>;
  /** ページの間を空ける時間（ミリ秒）。見本の口は 0。 */
  readonly delayMs: number;
}

/** 読めなかった（届かない・断られた・大きすぎる・社内のアドレス）。 */
export class FetchError extends Error {}

/** 読む上限の大きさ（バイト）。 */
const MAX_BYTES = 2 * 1024 * 1024;
/** 読む時間の上限。 */
const TIMEOUT_MS = 15_000;
/** 転送の上限。 */
const MAX_REDIRECTS = 3;

/**
 * つないではならないアドレスか（社内・自分自身・リンクローカル・クラウドの管理用・予約）。
 *
 * @param address IPv4 か IPv6 の文字列
 */
export function isBlockedAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number, number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) // 共有アドレス（CGN）
      || (a === 169 && b === 254) // リンクローカル（クラウドの管理用を含む）
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0) // 192.0.0.0/24・192.0.2.0/24
      || (a === 198 && (b === 18 || b === 19 || b === 51))
      || (a === 203 && b === 0);
  }
  if (v === 6) {
    const x = address.toLowerCase();
    if (x === '::' || x === '::1') return true;
    // IPv4 を埋めた形は IPv4 として確かめる
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isBlockedAddress(mapped[1]!);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x) || x.startsWith('64:ff9b:') || x.startsWith('2001:db8');
  }
  return true;
}

/** 接続の時に引いたアドレスを確かめる名前の引き方（社内のアドレスなら断る）。 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = (addresses as LookupAddress[]).filter((a) => !isBlockedAddress(a.address));
    if (list.length === 0) return callback(new FetchError('社内のアドレスには読みに行きません'), '', 0);
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    return callback(null, list[0]!.address, list[0]!.family);
  });
};

/**
 * 読みに行ってよい URL か（http・https、名前かグローバルのアドレス、既定のポート、ID とパスワードを含まない）。
 *
 * @returns よければ URL、だめなら理由
 */
export function checkUrl(raw: string): URL | string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'URL の形ではありません';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'http か https の URL だけを読みます';
  if (u.username || u.password) return 'ID やパスワードを含む URL は読みません';
  if (u.port && u.port !== '80' && u.port !== '443') return '既定のポートの URL だけを読みます';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isBlockedAddress(host)) return '社内のアドレスには読みに行きません';
  if (!isIP(host) && (!host.includes('.') || /\.(local|localhost|internal|lan|home|corp)$/i.test(host) || host === 'localhost')) {
    return '社外の Web サイトの URL だけを読みます';
  }
  return u;
}

/** 本物の Web を読む口。 */
export class HttpPageFetcher implements PageFetcher {
  readonly delayMs: number;

  /**
   * @param userAgent 名乗り（M2Office の名前と版と問い合わせ先。第36.7節）
   * @param delayMs ページの間を空ける時間（既定 5 秒）
   */
  constructor(private readonly userAgent: string, delayMs = 5_000) {
    this.delayMs = delayMs;
  }

  async get(url: string, accept: 'html' | 'text'): Promise<FetchedPage> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const checked = checkUrl(current);
      if (typeof checked === 'string') throw new FetchError(checked);
      const res = await this.once(checked, accept);
      if (res.status >= 300 && res.status < 400 && res.location) {
        current = new URL(res.location, checked).toString();
        continue;
      }
      return { url: checked.toString(), status: res.status, contentType: res.contentType, text: res.text };
    }
    throw new FetchError('転送が多すぎます');
  }

  private once(u: URL, accept: 'html' | 'text'): Promise<{ status: number; contentType: string; text: string; location: string | null }> {
    return new Promise((resolve, reject) => {
      const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, {
        method: 'GET', lookup: guardedLookup, timeout: TIMEOUT_MS,
        headers: {
          'user-agent': this.userAgent,
          accept: accept === 'html' ? 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5' : 'text/plain',
          'accept-encoding': 'gzip, deflate, br',
          'accept-language': 'ja,en;q=0.5',
        },
      }, (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers['content-type'] ?? '');
        const location = typeof res.headers.location === 'string' ? res.headers.location : null;
        if ((status >= 300 && status < 400) || status >= 400) {
          res.resume();
          return resolve({ status, contentType, text: '', location });
        }
        const okType = accept === 'html' ? /text\/html|application\/xhtml|text\/plain/i.test(contentType) || !contentType : /text\/plain/i.test(contentType) || !contentType;
        if (!okType) {
          res.resume();
          return reject(new FetchError('HTML のページではありません'));
        }
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
        const stream = enc === 'gzip' ? res.pipe(createGunzip()) : enc === 'br' ? res.pipe(createBrotliDecompress()) : enc === 'deflate' ? res.pipe(createInflate()) : res;
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            req.destroy();
            reject(new FetchError('ページが大きすぎます'));
            return;
          }
          chunks.push(c);
        });
        stream.on('end', () => resolve({ status, contentType, text: decode(Buffer.concat(chunks), contentType), location }));
        stream.on('error', (err) => reject(new FetchError(`読めませんでした（${err.message}）`)));
      });
      req.on('timeout', () => req.destroy(new FetchError('時間内に読めませんでした')));
      req.on('error', (err) => reject(err instanceof FetchError ? err : new FetchError(`届きませんでした（${err.message}）`)));
      req.end();
    });
  }
}

/** 文字の符号を見て読む（UTF-8 のほか、日本のサイトに多い Shift_JIS と EUC-JP）。 */
function decode(buf: Buffer, contentType: string): string {
  const head = buf.subarray(0, 2048).toString('latin1');
  const charset = (/charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? 'utf-8').toLowerCase();
  const label = /shift[_-]?jis|sjis|x-sjis|windows-31j|cp932/.test(charset) ? 'shift_jis' : /euc-jp/.test(charset) ? 'euc-jp' : 'utf-8';
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/** 見本の口のページ（URL ごと）。robots.txt も置ける。 */
export type MockSite = Record<string, { status?: number; body: string; contentType?: string }>;

/**
 * 開発の見本の会社で使う、外に出ない見本の口。決まったページだけを返す。
 *
 * @remarks 間を空けない（delayMs = 0）
 */
export class MockPageFetcher implements PageFetcher {
  readonly delayMs = 0;
  /** 読んだ URL（自動テストで、robots.txt に従ったかを確かめる）。 */
  readonly requested: string[] = [];

  constructor(private readonly pages: MockSite) {}

  async get(url: string): Promise<FetchedPage> {
    const checked = checkUrl(url);
    if (typeof checked === 'string') throw new FetchError(checked);
    const key = checked.toString();
    this.requested.push(key);
    const page = this.pages[key];
    if (!page) return { url: key, status: 404, contentType: 'text/html', text: '' };
    if (page.status && page.status >= 500) return { url: key, status: page.status, contentType: 'text/html', text: '' };
    return { url: key, status: page.status ?? 200, contentType: page.contentType ?? 'text/html; charset=utf-8', text: page.body };
  }
}

/**
 * 読むときの名乗り（User-Agent。第36.7節）。M2Office の名前と版と、問い合わせ先の URL。
 *
 * @param contactUrl 運営主体の案内のページ（配備のときに設定する。マスター管理画面ができるまでは環境変数 `CRAWLER_CONTACT_URL`）。無ければ付けない
 */
export function crawlerUserAgent(version: string, contactUrl: string | undefined): string {
  const contact = contactUrl && /^https?:\/\/\S+$/.test(contactUrl) ? `; +${contactUrl}` : '';
  return `Mozilla/5.0 (compatible; M2Office/${version}${contact})`;
}
