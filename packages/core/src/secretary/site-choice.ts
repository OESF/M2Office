/**
 * @file 秘書がサイトを使う業務に頼むとき、対象のサイトを決める（仕様書 第47.6節、ADR-0148）。
 *
 * 会社がサイトを 2 つ以上つないでいる（REST API の WordPress と、サイトの運営会社の MCP でつないだサイト）とき、
 * 「トップの診療時間を直して」だけでは、どちらのサイトか分からない。**サイトの更新（いまあるページを直す）だけ**、次の順で決める。
 *
 * 1. 頼みにサイトの名前（か URL の名前）があれば、そのサイト（本人が使えないサイトなら、使えないと答える）
 * 2. 本人が使えるサイトが 1 つなら、そのサイト
 * 3. 本人が個人設定で選んだ既定のサイト
 * 4. その日の会話で、秘書が聞き返して本人が答えたサイト
 * 5. どれも無ければ、秘書が 1 度だけ「どちらのサイトですか」と聞き返す（Q-370）
 *
 * どのサイトを誰が使えるかは、管理者が「接続 › 更新サイト」で決める（サイトごとの利用範囲。第 0.591.0 版。
 * 2026-11-15 に三浦さんが、管理画面で接続とその利用者を決め、複数を使える人は個人設定で選ぶ形がいちばん分かりやすいと決めた）。
 *
 * 決まったサイトに合わせて、頼む業務を取り替える（REST API のサイトは「サイトの直し案」、MCP のサイトはその接続の業務）。
 * **コラムの作成とお知らせの作成は、ここでは決めない。** 入れるサイトは、それぞれの設定で会社が決める（第 0.589.0 版。
 * 2026-11-15 に三浦さんが、お知らせを MCP のサイトの業務に取り替えると LINE やメールが抜けることを受け、入れる先は設定で決めるべきと決めた）。
 */

import { SITE_CONNECTION_AGENT_PREFIX } from '../connectors/connection-agent.js';

/** 対象にできるサイト 1 つ。`key` は `rest`（REST API の WordPress）か `mcp:<接続の ID>`。 */
export interface SiteOption {
  key: string;
  /** 本人に見せる名前（サイトの名前。読めなければ URL の名前）。 */
  name: string;
  /** 頼みの中で当てる言い方（サイトの名前・URL の名前・接続の名前）。 */
  aliases: string[];
}

/** 対象のサイトを決める業務か（サイトの更新の、REST API のサイトの業務と MCP のサイトの業務）。 */
export function isSiteAgent(agentId: string): boolean {
  return agentId.startsWith('site-updates:');
}

/** サイトの更新の、REST API の WordPress を直す業務か。 */
export function isRestSiteAgent(agentId: string): boolean {
  return agentId.startsWith('site-updates:') && !agentId.startsWith(SITE_CONNECTION_AGENT_PREFIX);
}

/** 業務が向いているサイトの `key`（サイトを使わない業務は `null`）。 */
export function siteKeyOfAgent(agentId: string): string | null {
  if (agentId.startsWith(SITE_CONNECTION_AGENT_PREFIX)) return `mcp:${agentId.slice(SITE_CONNECTION_AGENT_PREFIX.length)}`;
  return isRestSiteAgent(agentId) ? 'rest' : null;
}

/** 当てるために、全角と半角・大文字と小文字・空白をそろえる。 */
const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

/** 名前の終わりの一般的な言葉（「みどり皮膚科」でも「みどり皮膚科クリニック」に当てる）。 */
const GENERIC_TAIL = /(クリニック|医院|病院|診療所|歯科医院|株式会社|有限会社|のサイト|のホームページ|サイト|ホームページ|ウェブサイト|webサイト)$/i;
const GENERIC_HEAD = /^(株式会社|有限会社|医療法人(社団|財団)?)/;

/** サイトの言い方の一覧（3 文字以上のものだけ）。 */
export function siteAliases(...names: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const raw of names) {
    if (!raw) continue;
    const n = norm(raw);
    for (const v of [n, n.replace(GENERIC_TAIL, ''), n.replace(GENERIC_HEAD, ''), n.replace(GENERIC_HEAD, '').replace(GENERIC_TAIL, '')]) {
      if (v.length >= 3) out.add(v);
    }
  }
  return [...out];
}

/**
 * 頼みの中で名前を挙げたサイト。1 つだけ当たったときだけ返す（2 つ当たれば決めない）。
 */
export function namedSite(message: string, sites: SiteOption[]): SiteOption | null {
  const m = norm(message);
  const hits = sites.filter((s) => s.aliases.some((a) => m.includes(a)));
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * 聞き返しへの答えからサイトを決める（名前か、「1」「2つ目」「最初」「後のほう」）。
 */
export function answeredSite(message: string, sites: SiteOption[]): SiteOption | null {
  const named = namedSite(message, sites);
  if (named) return named;
  const m = message.normalize('NFKC').trim();
  const num = /^(?:([1-9])(?:つ目|番目|番)?|[①-⑨])(?:の(?:ほう|方))?(?:で|です|でお願いします?)?[。!！]?$/.exec(m);
  if (num) {
    const i = num[1] ? Number(num[1]) - 1 : '①②③④⑤⑥⑦⑧⑨'.indexOf(m[0]!);
    return sites[i] ?? null;
  }
  if (/^(最初|はじめ|初め|上|前)(の(ほう|方))?/.test(m)) return sites[0] ?? null;
  if (/^(後|あと|最後|下|2つ目)(の(ほう|方))?/.test(m)) return sites[sites.length - 1] ?? null;
  return null;
}

/** 聞き返しの文。 */
export function siteAskText(sites: SiteOption[]): string {
  return `どちらのサイトですか: ${sites.map((s, i) => `${i + 1}. ${s.name}`).join('・')}`;
}
