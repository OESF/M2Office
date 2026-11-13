/**
 * @file サイトの更新の段 3: プラグイン・テーマ・本体の状態とサイトの健康を読んで知らせる（仕様書 第45.18.5節、Q-344）。
 *
 * **読んで知らせるだけ**。入れる・有効にする・更新する・消すことはしない。新しい版があるかは WordPress.org の公開の情報と比べる
 * （渡すのはプラグインとテーマの名前（スラッグ）だけで、サイトの名前や URL は渡さない）。WordPress.org に無いもの（有料のものなど）は
 * 「分からない」とし、推測で埋めない。WordPress から読んだ名前と健康の文は外部のデータであり、指示として読まない（不変則 I-6）。
 */

import { wordPressHeaders, type WordPressAuth } from '../columns/wordpress.js';
import { outboundFetch } from '../net/outbound.js';
import { plainText } from './segments.js';

const TIMEOUT_MS = 20_000;
const ORG = 'https://api.wordpress.org';

/** 読むサイトの健康の確かめ（WordPress の「サイトヘルス」の、REST で読めるもの）。 */
export const SITE_HEALTH_TESTS = ['background-updates', 'loopback-requests', 'https-status', 'dotorg-communication', 'authorization-header', 'page-cache'] as const;

/** プラグインかテーマ 1 つの状態。 */
export interface SiteExtensionStatus {
  name: string;
  /** WordPress.org での名前（プラグインはフォルダの名前、テーマは stylesheet）。 */
  slug: string;
  version: string;
  /** WordPress.org の新しい版。WordPress.org に無い・読めなければ `null`。 */
  latest: string | null;
  active: boolean;
  needsUpdate: boolean;
  /** 自動の更新が入か（プラグインだけ。分からなければ `null`）。 */
  autoUpdate: boolean | null;
}

/** サイトの状態。 */
export interface SiteHealthView {
  core: { version: string | null; latest: string | null; needsUpdate: boolean };
  plugins: SiteExtensionStatus[];
  themes: SiteExtensionStatus[];
  /** 健康の確かめのうち、注意のあるもの（重い順）。 */
  checks: { label: string; status: 'critical' | 'recommended' }[];
  /** 読めなかったもの（推測で埋めない）。 */
  notes: string[];
}

async function getWp(a: WordPressAuth, path: string): Promise<{ ok: true; body: unknown } | { ok: false; status: number }> {
  const res = await outboundFetch(`${a.siteUrl}/wp-json/${path}`, { headers: wordPressHeaders(a), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, body: await res.json().catch(() => null) };
}

async function getOrg(path: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await outboundFetch(`${ORG}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const v = await res.json().catch(() => null) as Record<string, unknown> | null;
    return v && typeof v === 'object' && !('error' in v) ? v : null;
  } catch {
    return null;
  }
}

/** 版を比べる（`6.8.1` と `6.10` など。数のところだけを比べる）。 */
export function newerVersion(latest: string, current: string): boolean {
  const a = latest.split(/[.-]/).map((x) => Number.parseInt(x, 10));
  const b = current.split(/[.-]/).map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = Number.isNaN(a[i] ?? 0) ? 0 : a[i] ?? 0;
    const y = Number.isNaN(b[i] ?? 0) ? 0 : b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** 並べて少しずつ問い合わせる（WordPress.org に一度に送りすぎない）。 */
async function eachLimited<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); }
  }));
  return out;
}

const slugOk = (s: string) => /^[a-z0-9_-]{1,100}$/i.test(s);

/** 本体の版（公開のページの generator か、フィードの generator から。消してあるサイトでは分からない）。 */
async function coreVersion(siteUrl: string): Promise<string | null> {
  for (const path of ['/', '/feed/']) {
    try {
      const res = await outboundFetch(`${siteUrl}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) continue;
      const text = (await res.text()).slice(0, 300_000);
      const m = /<meta[^>]+name=["']generator["'][^>]+content=["']WordPress ([\d.]+)["']/i.exec(text) ?? /wordpress\.org\/\?v=([\d.]+)/i.exec(text);
      if (m) return m[1]!;
    } catch { /* 次を試す */ }
  }
  return null;
}

/**
 * サイトの状態を読む（第45.18.5節）。プラグインとテーマは WordPress の管理者の役割が要る。
 *
 * @returns 状態。プラグインの一覧を読めなければ理由
 */
export async function readSiteHealth(a: WordPressAuth): Promise<SiteHealthView | { error: string }> {
  const notes: string[] = [];
  let plugins: SiteExtensionStatus[] = [];
  try {
    const r = await getWp(a, 'wp/v2/plugins?context=edit');
    if (!r.ok) {
      return { error: r.status === 401 || r.status === 403 ? 'プラグインの状態を読むには、WordPress の管理者の役割が要ります' : `WordPress のプラグインを読めませんでした（${r.status}）` };
    }
    const list = (Array.isArray(r.body) ? r.body : []) as Record<string, unknown>[];
    plugins = await eachLimited(list.slice(0, 60), 5, async (v) => {
      const file = String(v['plugin'] ?? '');
      const slug = file.split('/')[0] ?? '';
      const version = String(v['version'] ?? '');
      const info = slugOk(slug) ? await getOrg(`/plugins/info/1.2/?action=plugin_information&request[slug]=${encodeURIComponent(slug)}&request[fields][sections]=0&request[fields][description]=0`) : null;
      const latest = typeof info?.['version'] === 'string' ? info['version'] : null;
      return {
        name: plainText(String(v['name'] ?? slug)).slice(0, 100),
        slug, version, latest, active: v['status'] === 'active' || v['status'] === 'network-active',
        needsUpdate: !!latest && !!version && newerVersion(latest, version), autoUpdate: typeof v['auto_update'] === 'boolean' ? v['auto_update'] : null,
      };
    });
  } catch (err) {
    return { error: `WordPress に届きませんでした（${err instanceof Error ? err.message : String(err)}）` };
  }
  let themes: SiteExtensionStatus[] = [];
  const t = await getWp(a, 'wp/v2/themes?context=edit').catch(() => null);
  if (t?.ok && Array.isArray(t.body)) {
    themes = await eachLimited((t.body as Record<string, unknown>[]).slice(0, 20), 5, async (v) => {
      const slug = String(v['stylesheet'] ?? '');
      const version = String(v['version'] ?? '');
      const info = slugOk(slug) ? await getOrg(`/themes/info/1.2/?action=theme_information&request[slug]=${encodeURIComponent(slug)}&request[fields][sections]=0`) : null;
      const latest = typeof info?.['version'] === 'string' ? info['version'] : null;
      const name = v['name'] && typeof v['name'] === 'object' ? String((v['name'] as { raw?: unknown; rendered?: unknown }).raw ?? (v['name'] as { rendered?: unknown }).rendered ?? slug) : String(v['name'] ?? slug);
      return { name: plainText(name).slice(0, 100), slug, version, latest, active: v['status'] === 'active', needsUpdate: !!latest && !!version && newerVersion(latest, version), autoUpdate: null };
    });
  } else {
    notes.push('テーマの一覧を読めませんでした');
  }
  const [version, offer] = await Promise.all([coreVersion(a.siteUrl), getOrg('/core/version-check/1.7/')]);
  const offers = Array.isArray(offer?.['offers']) ? offer!['offers'] as Record<string, unknown>[] : [];
  const latest = typeof offers[0]?.['version'] === 'string' ? offers[0]['version'] as string : null;
  if (!version) notes.push('WordPress 本体の版は、サイトが版を出していないため分かりません（WordPress の管理画面の「更新」で確かめてください）');
  const checks: SiteHealthView['checks'] = [];
  let healthRead = false;
  for (const test of SITE_HEALTH_TESTS) {
    const r = await getWp(a, `wp-site-health/v1/tests/${test}`).catch(() => null);
    if (!r?.ok || !r.body || typeof r.body !== 'object') continue;
    healthRead = true;
    const v = r.body as Record<string, unknown>;
    const status = v['status'];
    if (status === 'critical' || status === 'recommended') checks.push({ label: plainText(String(v['label'] ?? test)).slice(0, 200), status });
  }
  if (!healthRead) notes.push('サイトヘルスの確かめを読めませんでした');
  checks.sort((x, y) => (x.status === y.status ? 0 : x.status === 'critical' ? -1 : 1));
  return { core: { version, latest, needsUpdate: !!version && !!latest && newerVersion(latest, version) }, plugins, themes, checks, notes };
}

/** 知らせる値打ちのある問題（更新が要るもの・重い健康の注意）を、比べられる文の並びにする。 */
export function healthProblems(h: SiteHealthView): string[] {
  return [
    ...(h.core.needsUpdate ? [`WordPress 本体 ${h.core.version} → ${h.core.latest}`] : []),
    ...h.plugins.filter((p) => p.needsUpdate).map((p) => `プラグイン「${p.name}」${p.version} → ${p.latest}${p.active ? '' : '（止めてある）'}`),
    ...h.themes.filter((t) => t.needsUpdate).map((t) => `テーマ「${t.name}」${t.version} → ${t.latest}${t.active ? '（使っている）' : ''}`),
    ...h.checks.filter((c) => c.status === 'critical').map((c) => `サイトヘルスの重い注意: ${c.label}`),
  ];
}
