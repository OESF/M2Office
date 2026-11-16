/**
 * @file コラムの引用の出典を、本物のページの題名と URL にする（仕様書 第32.7.2節。第 0.598.0 版）。
 *
 * コラムには出典の一覧を付けない。ただし、調べたページの文をそのまま使う（引用する）ときは、
 * 引用とわかる形（Markdown の `>` の引用）にし、その直後に出典を明記する。
 * 推論には URL を作らせず、調べたページの番号を `{{出典:N}}` と書かせ、M2Office がページを読んで置き換える。
 * 調べものが返す URL は検索の転送の URL（`vertexaisearch.cloud.google.com` など）のことがあるため、
 * ページを読んで、着いた先の URL とページの題名を使う。
 */

import type { ColumnReviewItem, ColumnSource } from '@m2office/shared';
import type { PageFetcher } from '../competitors/fetcher.js';
import { readHtml } from '../competitors/html.js';

/** 推論が書く、引用の出典の印。`{{出典:2}}` のように調べたページの番号を書く。 */
export const CITE_MARK = /\{\{出典:\s*(\d{1,2})\s*\}\}/g;

/** ページの題名の長さの上限。 */
const TITLE_MAX = 80;

/** 出典の行に出すページの題名（題名が無ければサイトの名前）。 */
function citeTitle(title: string, url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, '');
  const t = title.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
  return t ? `${t}（${host}）` : host;
}

/**
 * 本文の引用の出典の印を、本物のページの題名と URL のリンクに置き換える。
 *
 * @param fetcher ページを読む口。無ければ（見本の会社・読めない環境）出典を確かめられない
 * @returns 置き換えた本文と、確かめられなかった引用の指摘
 * @remarks
 * 危険度: read（公開のページを読むだけ。robots.txt と社内のアドレスの扱いは読む口に従う）。
 * 番号が調べたページに無い・ページを読めない引用は、出典を書けないので印を外し、校正に「出典を確かめられない引用」として出す
 */
export async function resolveCitations(body: string, sources: ColumnSource[], fetcher: PageFetcher | null): Promise<{ body: string; review: ColumnReviewItem[] }> {
  const wanted = [...new Set([...body.matchAll(CITE_MARK)].map((m) => Number(m[1])))];
  if (wanted.length === 0) return { body, review: [] };
  const links = new Map<number, string>();
  for (const n of wanted) {
    const s = sources[n - 1];
    if (!s || !fetcher) continue;
    try {
      const page = await fetcher.get(s.url, 'html');
      if (page.status >= 400) continue;
      const title = page.contentType.includes('html') ? readHtml(page.text, page.url).title : '';
      links.set(n, `[${citeTitle(title || s.title, page.url)}](${page.url})`);
    } catch {
      // 読めなかったページは出典にできない（下で指摘にする）
    }
  }
  const review: ColumnReviewItem[] = [];
  const out = body.replace(CITE_MARK, (_all, num: string) => {
    const link = links.get(Number(num));
    if (link) return link;
    review.push({ quote: '', reason: '引用の出典のページを確かめられませんでした。引用を外すか、出典を書き足してください', suggestion: '', by: 'rule', kind: 'source' });
    return '（出典を確かめられませんでした）';
  });
  return { body: out, review: review.slice(0, 1) };
}

/** 本文から、引用（`>` の行）と出典の行を除いた部分（似すぎの確かめで、明示した引用を指摘しないため）。 */
export function withoutQuotes(body: string): string {
  return body.split('\n').filter((l) => !/^\s*>/.test(l) && !/^\s*出典[:：]/.test(l)).join('\n');
}
