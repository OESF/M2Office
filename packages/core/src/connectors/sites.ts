/**
 * @file 会社がつないでいるサイトと、本人が使えるサイト・入れるサイトを決める（仕様書 第47.3節・第47.6節、ADR-0148）。
 *
 * サイトは、REST API でつないだ WordPress（`rest`）と、サイトの運営会社の MCP でつないだサイト（`mcp:<接続の ID>`）。
 * 誰がどのサイトを使えるかは管理者が「接続 › 更新サイト」で決め（サイトごとの利用範囲）、使えるサイトが 2 つ以上の人は個人設定で既定のサイトを選ぶ。
 * サイトの更新・コラムの作成・お知らせの作成は、どれもこの決め方に従う（2026-11-15 に三浦さんが決めた。管理画面で入れ先を固定しない）。
 */

import { canUseAgent, siteScopeTarget, type AgentDefinition } from '@m2office/shared';
import type { Repository, TenantConnection } from '../repository/types.js';
import { readSiteName } from '../site-updates/wordpress.js';
import { siteAliases, type SiteOption } from '../secretary/site-choice.js';
import { siteConnectionAgentId, siteLabelOf } from './connection-agent.js';

/** REST API の WordPress のサイトの名前（公開のページから読む）。1 時間覚える（頼むたびに問い合わせない）。 */
const restSiteNames = new Map<string, { name: string | null; at: number }>();

/** URL の名前の部分（読めなければそのまま）。 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * 会社がつないでいるサイト。REST API の WordPress と、サイトの更新の付属の業務になった MCP のサイト。
 *
 * @param opts.anyRest REST API の WordPress は、サイトの更新が無くても並べる（コラム・お知らせの入れ先として）
 * @remarks 危険度: read（REST API のサイトの公開のページの題名を読むだけ）
 */
export async function siteOptions(
  view: { agents: AgentDefinition[]; connections: TenantConnection[] },
  restUrl: string | null,
  opts: { anyRest?: boolean } = {},
): Promise<SiteOption[]> {
  const out: SiteOption[] = [];
  if (restUrl && (opts.anyRest || view.agents.some((a) => a.id.startsWith('site-updates:') && !a.id.startsWith('site-updates:site-')))) {
    let cached = restSiteNames.get(restUrl);
    if (!cached || Date.now() - cached.at > 3_600_000) {
      cached = { name: (await readSiteName(restUrl).catch(() => null))?.name ?? null, at: Date.now() };
      restSiteNames.set(restUrl, cached);
    }
    const host = hostOf(restUrl);
    out.push({ key: 'rest', name: cached.name || host, aliases: siteAliases(cached.name, host) });
  }
  for (const c of view.connections) {
    if (!c.profile?.site || !view.agents.some((a) => a.id === siteConnectionAgentId(c.id))) continue;
    const label = siteLabelOf(c);
    out.push({ key: `mcp:${c.id}`, name: label, aliases: siteAliases(label, c.name, c.profile.siteUrl ? hostOf(c.profile.siteUrl) : null) });
  }
  return out;
}

/** 本人の使えるサイトを読むのに要るもの。 */
export interface UserSitesDeps {
  repo: Repository;
  tenantView(tenantId: string): Promise<{ agents: AgentDefinition[]; connections: TenantConnection[] }>;
}

/**
 * 本人が使えるサイトと、使えないサイト・既定のサイト。サイトごとの利用範囲で分ける。
 *
 * @remarks 既定のサイトは、使えるサイトの中にあるときだけ返す（使えなくなったサイトは既定にしない）。
 * REST API の WordPress は、つないでいれば並べる（コラムとお知らせの入れ先にもなるため）
 */
export async function userSites(deps: UserSitesDeps, tenantId: string, userId: string): Promise<{ sites: SiteOption[]; denied: SiteOption[]; site: string | null }> {
  const [view, settings, mine, groups] = await Promise.all([
    deps.tenantView(tenantId), deps.repo.getTenantSettings(tenantId), deps.repo.getUserSettings(tenantId, userId), deps.repo.listUserGroupIds(tenantId, userId),
  ]);
  const all = await siteOptions(view, settings.webColumns.wordpress?.siteUrl ?? null, { anyRest: true });
  const ok = (s: SiteOption) => canUseAgent(settings.access, siteScopeTarget(s.key), userId, groups);
  const sites = all.filter(ok);
  const site = mine.secretary.site && sites.some((s) => s.key === mine.secretary.site) ? mine.secretary.site : null;
  return { sites, denied: all.filter((s) => !ok(s)), site };
}

/**
 * コラムやお知らせを入れるサイト。`null` は入れるサイトが無い（つないでいない・使えるサイトが無い）。
 * `ask` は、使えるサイトが 2 つ以上で既定のサイトを決めていないとき（決まらないまま入れない）。
 */
export type OutputSite = { key: string; name: string } | { ask: string } | null;

/** 入れるサイトの決まらないときの言葉。 */
export const OUTPUT_SITE_ASK = '入れるサイトを決めてください（個人設定の「サービスとの接続」の「既定のサイト」）';

/**
 * 本人がコラムやお知らせを入れるサイトを決める（第47.6節）。使えるサイトが 1 つならそれ、2 つ以上なら既定のサイト。
 */
export async function outputSiteOf(deps: UserSitesDeps, tenantId: string, userId: string): Promise<OutputSite> {
  const { sites, site } = await userSites(deps, tenantId, userId);
  if (sites.length === 0) return null;
  if (sites.length === 1) return { key: sites[0]!.key, name: sites[0]!.name };
  const chosen = site ? sites.find((s) => s.key === site) : undefined;
  return chosen ? { key: chosen.key, name: chosen.name } : { ask: OUTPUT_SITE_ASK };
}
