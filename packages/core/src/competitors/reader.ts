/**
 * @file 1 つの Web サイトを読む（仕様書 第36.7節）。robots.txt に従い、トップと主なページを 1 社 10 ページまで、間を空けて 1 本ずつ読む。
 *
 * 読んだ文字は呼ぶ側が事実を取り出す間だけ持ち、残さない。読めなかったページは数え、理由を一言にする。
 */

import { COMPETITOR_PAGES_MAX } from '@m2office/shared';
import type { LlmProvider } from '../llm/provider.js';
import { pickPages } from './analyze.js';
import { FetchError, checkUrl, type PageFetcher } from './fetcher.js';
import { readHtml, type PageContent } from './html.js';
import type { RobotsCache } from './robots.js';

/** 読んだ結果。 */
export interface SiteReading {
  /** 読めたページ（残さない） */
  pages: PageContent[];
  read: number;
  failed: number;
  /** 読めなかった理由（読めたら空） */
  note: string;
}

/** 読むのに使うもの。 */
export interface ReaderDeps {
  fetcher: PageFetcher;
  robots: RobotsCache;
  llm: LlmProvider | null;
  /** 待つ（自動テストでは待たない） */
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * サイトを読む。
 *
 * @param maxPages 読むページの上限（既定 10。候補の確かめではトップだけの 1）
 */
export async function readSite(deps: ReaderDeps, url: string, maxPages = COMPETITOR_PAGES_MAX): Promise<SiteReading> {
  const sleep = deps.sleep ?? wait;
  const checked = checkUrl(url);
  if (typeof checked === 'string') return { pages: [], read: 0, failed: 1, note: checked };
  if (!(await deps.robots.allows(checked.toString()))) {
    return { pages: [], read: 0, failed: 0, note: 'robots.txt で読むことが断られているか、robots.txt を読めないため、読みませんでした' };
  }
  let top: PageContent;
  try {
    const res = await deps.fetcher.get(checked.toString(), 'html');
    if (res.status !== 200) return { pages: [], read: 0, failed: 1, note: `トップのページを読めませんでした（${res.status}）` };
    // 転送で別のサイトに着いたら、そのサイトの robots.txt も確かめる
    if (new URL(res.url).origin !== checked.origin && !(await deps.robots.allows(res.url))) {
      return { pages: [], read: 0, failed: 0, note: 'robots.txt で読むことが断られているため、読みませんでした' };
    }
    top = readHtml(res.text, res.url);
  } catch (err) {
    return { pages: [], read: 0, failed: 1, note: err instanceof FetchError ? `トップのページを読めませんでした（${err.message}）` : 'トップのページを読めませんでした' };
  }
  const pages = [top];
  let failed = 0;
  if (maxPages > 1) {
    const targets = (await pickPages(deps.llm, top.links)).slice(0, maxPages - 1);
    for (const target of targets) {
      if (!(await deps.robots.allows(target))) continue;
      // 1 社は 1 本ずつ、ページの間を空ける（相手のサイトに負荷をかけない）
      if (deps.fetcher.delayMs > 0) await sleep(deps.fetcher.delayMs);
      try {
        const res = await deps.fetcher.get(target, 'html');
        if (res.status === 200 && new URL(res.url).origin === new URL(top.url).origin) pages.push(readHtml(res.text, res.url));
        else failed += 1;
      } catch (err) {
        if (!(err instanceof FetchError)) throw err;
        failed += 1;
      }
    }
  }
  return { pages, read: pages.length, failed, note: '' };
}
