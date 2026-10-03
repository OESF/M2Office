/**
 * @file robots.txt に従う（RFC 9309。仕様書 第36.7節）。
 *
 * 自分の名前（`M2Office`）に当てはまるまとまりがあればそれを、無ければ `*` のまとまりを使う。
 * いちばん長く当てはまる規則が勝ち、同じ長さなら Allow が勝つ。`*` と `$` を扱う。
 * robots.txt が 4xx なら全部読んでよい。5xx か届かなければ、そのサイトは読まない。覚えておくのは 24 時間まで。
 */

import { FetchError, type PageFetcher } from './fetcher.js';

/** 名乗りのうち、robots.txt のまとまりを選ぶ名前。 */
export const ROBOTS_AGENT = 'm2office';

/** 覚えておく時間（RFC 9309 では 24 時間まで）。 */
const CACHE_MS = 24 * 3_600_000;

/** 1 サイトの決まり。 */
export interface RobotsRules {
  /** 全部読んではならない（5xx か届かない） */
  disallowAll: boolean;
  rules: { allow: boolean; pattern: string }[];
}

/**
 * robots.txt を読んで、自分に効く規則を返す。
 *
 * @param agent 自分の名前（小文字）
 */
export function parseRobots(text: string, agent = ROBOTS_AGENT): RobotsRules {
  const groups: { agents: string[]; rules: { allow: boolean; pattern: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  // RFC 9309 では少なくとも 500 KiB は読む
  for (const raw of text.slice(0, 512 * 1024).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && current) {
      lastWasAgent = false;
      // 空の Disallow は「何も禁じない」
      if (value) current.rules.push({ allow: key === 'allow', pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && agent.includes(a.replace(/\/.*$/, ''))));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  return { disallowAll: false, rules: chosen.flatMap((g) => g.rules) };
}

/** 規則の形を正規表現にする（`*` は何でも、末尾の `$` は終わり）。 */
function toRegex(pattern: string): RegExp {
  const end = pattern.endsWith('$');
  const body = (end ? pattern.slice(0, -1) : pattern).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${end ? '$' : ''}`);
}

/**
 * その道（パスと検索の部分）を読んでよいか。
 *
 * @param path `/` から始まる道（例: `/menu?x=1`）
 */
export function robotsAllows(rules: RobotsRules, path: string): boolean {
  if (rules.disallowAll) return false;
  if (path === '/robots.txt') return true;
  let best: { allow: boolean; length: number } | null = null;
  for (const r of rules.rules) {
    if (!toRegex(r.pattern).test(path)) continue;
    const length = r.pattern.length;
    if (!best || length > best.length || (length === best.length && r.allow)) best = { allow: r.allow, length };
  }
  return best ? best.allow : true;
}

/** サイトごとの robots.txt を 24 時間まで覚えて引く。 */
export class RobotsCache {
  private readonly cache = new Map<string, { at: number; rules: RobotsRules }>();

  constructor(private readonly fetcher: PageFetcher, private readonly now: () => number = Date.now) {}

  /** その URL を読んでよいか。 */
  async allows(url: string): Promise<boolean> {
    const u = new URL(url);
    return robotsAllows(await this.rulesFor(u.origin), `${u.pathname}${u.search}`);
  }

  /** サイトの決まり。5xx か届かなければ全部禁じる。 */
  async rulesFor(origin: string): Promise<RobotsRules> {
    const hit = this.cache.get(origin);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.rules;
    let rules: RobotsRules;
    try {
      const res = await this.fetcher.get(`${origin}/robots.txt`, 'text');
      if (res.status >= 500) rules = { disallowAll: true, rules: [] };
      else if (res.status >= 400) rules = { disallowAll: false, rules: [] };
      else if (res.status >= 200 && res.status < 300) rules = parseRobots(res.text);
      else rules = { disallowAll: true, rules: [] };
    } catch (err) {
      // 届かない・転送が多すぎるなどは、読まない側に倒す（RFC 9309 の「届かない」）
      rules = { disallowAll: true, rules: [] };
      if (!(err instanceof FetchError)) throw err;
    }
    this.cache.set(origin, { at: this.now(), rules });
    return rules;
  }
}
