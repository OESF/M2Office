/**
 * @file 競合の分析の処理（仕様書 第36章・第36.18節）。自社の像・競合を探す・足す・外す・読む・その場のレポート。
 *
 * 探す・読むは時間がかかるため、作業（`competitor_jobs`）として受け付け、ワーカーが 1 つずつ行う（{@link CompetitorWatch}）。
 * 地図（Places API）で見つけた競合は place ID だけを残し、名前・Web サイトは使うたびに引き直す（第36.13節）。
 * 相手のページの文章は残さず、取り出した事実と出典の URL・ページの印だけを残す。社外へは何も送らない（読むだけ）。
 */

import { randomUUID } from 'node:crypto';
import {
  COMPETITORS_AUTO_RANGE, COMPETITORS_EXTENSION_ID, competitorAutoMax, competitorsMax, competitorWatch, canUseAgent,
  type Competitor, type CompetitorFact, type CompetitorFactKind, type CompetitorWatchInterval, type CompetitorJob, type CompetitorOverview, type CompetitorProfile, type CompetitorReport, type CompetitorSettings,
} from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import type { SecretBox } from '../secrets/box.js';
import type { LlmProvider } from '../llm/provider.js';
import { silentLogger, type Logger } from '../log/logger.js';
import { dateIn } from '../cards/service.js';
import {
  checkCandidates, movesOf, suggestThemes, suggestAnnouncements, decideArea, extractFacts, findUrlByName, suggestCompetitors, summarizeProfile, writeReport,
  type AreaDecision, type Candidate, type ExtractedFact, type ReportSubject,
} from './analyze.js';
import { HttpPageFetcher, MockPageFetcher, checkUrl, type PageFetcher } from './fetcher.js';
import { GooglePlacesClient, MockPlaces, PlacesUnavailableError, checkPlacesKey, distanceM, type PlaceHit, type PlacesClient } from './places.js';
import { readSite, type SiteReading } from './reader.js';
import { RobotsCache } from './robots.js';
import { MOCK_SITES } from './mock-sites.js';
import type { CompetitorStore, StoredCompetitor, StoredJob } from './store.js';

/** 競合の分析の処理に使うもの。 */
export interface CompetitorServiceDeps {
  store: CompetitorStore;
  repo: Repository;
  llmFor(tenantId: string): Promise<LlmProvider>;
  /**
   * 会社の Gemini の鍵（地図の鍵を預けていないとき、昔の形 `AIza` の鍵だけを地図に使う）。無ければ `null`
   */
  placesKeyFor(tenantId: string): Promise<string | null>;
  /** 地図の鍵を預ける・取り出すための暗号（無ければ地図の鍵を預けられない） */
  box?: SecretBox;
  /** その会社の出どころ（`mock` なら外に出ない見本の地図とサイト） */
  sourceFor(tenantId: string): string;
  /** 外部の AI と地図を使ってよいか（ローカルだけの会社は使えない。第36.13節）。無ければ使ってよい */
  externalAllowed?(tenantId: string): Promise<boolean>;
  /** 名乗り（User-Agent。M2Office の名前と版と問い合わせ先。第36.7節） */
  userAgent: string;
  /** ページの間を空ける時間（既定 5 秒。第36.7節） */
  delayMs?: number;
  logger?: Logger;
  /**
   * 問い合わせの記録の「どこで知ったか」（第36.9節・第36.20節）。決まった日時より後の問い合わせのもの。問い合わせの記録を使っていなければ空
   */
  inquirySources?(tenantId: string, since: string): Promise<string[]>;
  /** 自動テスト用: 読む口・地図の口・待ち方の差し替え */
  fetcherFor?(tenantId: string): PageFetcher;
  placesFor?(tenantId: string): Promise<PlacesClient | null>;
  sleep?(ms: number): Promise<void>;
}

/** 依頼した人。 */
export interface CompetitorViewer {
  tenantId: string;
  userId: string;
}

/** 自社の像をまとめた結果（地図で探すのに使うものを含む）。 */
interface BuiltProfile {
  profile: CompetitorProfile;
  selfPlaceId: string | null;
  places: PlacesClient | null;
  mapNote: string;
  /** 地図で探す種類（AI が選んだもの） */
  types: string[];
}

/** 緯度と経度を持ってよい日数（第36.13節）。 */
const LOCATION_DAYS = 30;
/** 作業が止まったとみなす時間。 */
const STALE_MS = 2 * 3_600_000;

/**
 * 利用者が競合の分析を使えるか（会社の入り切りと利用範囲。第16.7節）。
 *
 * @returns 使えるなら会社の設定、使えなければ `null`
 */
export function competitorsAccess(repo: Repository) {
  return async (tenantId: string, userId: string): Promise<CompetitorSettings | null> => {
    const settings = await repo.getTenantSettings(tenantId);
    if (!settings.competitors.enabled) return null;
    const groups = await repo.listUserGroupIds(tenantId, userId);
    if (!canUseAgent(settings.access, COMPETITORS_EXTENSION_ID, userId, groups)) return null;
    return settings.competitors;
  };
}

/** 回（日本の年月）。 */
export const competitorPeriodOf = (now: Date) => dateIn('Asia/Tokyo', now);

/** 競合ごとに残す回の数（第36.19節）。 */
const KEEP_PERIODS = 13;
/** 探し直すまでの日数（第36.5節・第36.19節）。 */
const REDISCOVER_DAYS = 90;
/** 定期の見回りを始める時刻（日本時間の時。朝には届いているように）。 */
const WATCH_HOUR_JST = 3;
/** 仕組みが行ったことを示す人の ID。 */
export const COMPETITOR_SYSTEM = 'system';

/**
 * いまの回の始まり（毎月は 1 日、毎週は月曜の、日本時間 3 時）。
 *
 * @returns 始まりの日時。`now` がまだ今の回の始まりより前なら、前の回の始まり
 */
export function watchPeriodStart(interval: 'monthly' | 'weekly', now: Date): Date {
  const jst = new Date(now.getTime() + 9 * 3_600_000);
  const y = jst.getUTCFullYear();
  const m = jst.getUTCMonth();
  const at = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm, dd, WATCH_HOUR_JST - 9));
  if (interval === 'monthly') {
    const start = at(y, m, 1);
    return start <= now ? start : at(y, m - 1, 1);
  }
  const dow = (jst.getUTCDay() + 6) % 7; // 月曜を 0
  const start = at(y, m, jst.getUTCDate() - dow);
  return start <= now ? start : new Date(start.getTime() - 7 * 86_400_000);
}

/** 次の回の始まり。 */
export function nextWatchStart(interval: 'monthly' | 'weekly', now: Date): Date {
  const cur = watchPeriodStart(interval, now);
  if (interval === 'weekly') return new Date(cur.getTime() + 7 * 86_400_000);
  const jst = new Date(cur.getTime() + 9 * 3_600_000);
  return new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() + 1, 1, WATCH_HOUR_JST - 9));
}

/** 社名の比べ方（株式会社などを外して、頭の 4 字が含まれるか）。 */
function sameName(a: string, b: string): boolean {
  const core = (x: string) => x.replace(/株式会社|有限会社|合同会社|（.*?）|\(.*?\)|\s/g, '');
  const x = core(a);
  const y = core(b);
  if (!x || !y) return false;
  return x.includes(y.slice(0, 4)) || y.includes(x.slice(0, 4));
}

/**
 * 競合の分析の操作。
 *
 * @remarks 呼ぶ前に、利用者が使えるかを {@link competitorsAccess} で確かめること
 */
export class CompetitorService {
  private readonly log: Logger;
  private readonly robots = new Map<string, RobotsCache>();

  constructor(private readonly deps: CompetitorServiceDeps) {
    this.log = deps.logger ?? silentLogger;
  }

  /** 置き場（ツールが読むため）。 */
  get store(): CompetitorStore {
    return this.deps.store;
  }

  private mock(tenantId: string): boolean {
    return this.deps.sourceFor(tenantId) === 'mock';
  }

  private fetcher(tenantId: string): PageFetcher {
    if (this.deps.fetcherFor) return this.deps.fetcherFor(tenantId);
    return this.mock(tenantId) ? new MockPageFetcher(MOCK_SITES) : (this.http ??= new HttpPageFetcher(this.deps.userAgent, this.deps.delayMs ?? 5_000));
  }

  private http: HttpPageFetcher | null = null;

  private robotsFor(tenantId: string, fetcher: PageFetcher): RobotsCache {
    // 見本の口は会社ごと、本物の口はプロセスで 1 つ（同じサイトの robots.txt を何度も読まない）
    const key = fetcher instanceof HttpPageFetcher ? 'http' : `t:${tenantId}`;
    let cache = this.robots.get(key);
    if (!cache) {
      cache = new RobotsCache(fetcher);
      this.robots.set(key, cache);
    }
    return cache;
  }

  private async places(tenantId: string): Promise<{ client: PlacesClient | null; note: string }> {
    if (this.deps.placesFor) {
      const client = await this.deps.placesFor(tenantId);
      return { client, note: client ? '' : '地図（Places API）を使えません' };
    }
    if (this.mock(tenantId)) return { client: new MockPlaces(), note: '' };
    const key = await this.mapKey(tenantId);
    if (!key) return { client: null, note: '地図の鍵がありません。管理者が拡張機能の「競合の分析」の設定で、地図の鍵（Google Cloud の API キー）を入れてください' };
    return { client: new GooglePlacesClient(key), note: '' };
  }

  /** 地図に使う鍵。預けた地図の鍵を先に、無ければ昔の形（AIza）の Gemini の鍵（第 0.237.0 版）。 */
  private async mapKey(tenantId: string): Promise<string | null> {
    const cred = await this.deps.repo.getTenantCredential(tenantId, 'places').catch(() => null);
    if (cred?.secretEnc && this.deps.box) {
      try {
        return this.deps.box.decrypt(cred.secretEnc);
      } catch {
        return null;
      }
    }
    const gemini = await this.deps.placesKeyFor(tenantId).catch(() => null);
    return gemini?.startsWith('AIza') ? gemini : null;
  }

  /**
   * 地図の鍵を預ける（管理者だけ。呼ぶ側が確かめる）。Places API を使えるかを確かめてから、会社の鍵の置き場に暗号化して置く。
   *
   * @param mock 開発の見本の会社（鍵を確かめない）
   * @returns 預けられなければ理由
   */
  async setMapKey(who: CompetitorViewer, key: string, mock: boolean): Promise<string | null> {
    const value = key.trim();
    if (!value) return '地図の鍵を入れてください';
    if (!this.deps.box) return '鍵を預ける仕組みがありません';
    if (!mock) {
      const problem = await checkPlacesKey(value);
      if (problem) return problem;
    }
    const now = new Date().toISOString();
    await this.deps.repo.saveTenantCredential({
      tenantId: who.tenantId, kind: 'places', secretEnc: this.deps.box.encrypt(value), meta: mock ? { mock: true } : {}, updatedBy: who.userId, updatedAt: now,
    });
    const settings = await this.deps.repo.getTenantSettings(who.tenantId);
    await this.deps.repo.saveTenantSettings(who.tenantId, 'competitors', { ...settings.competitors, mapKey: { setBy: who.userId, setAt: now } }, who.userId);
    await this.audit(who, 'competitor.map_key_set', 'map-key', {});
    return null;
  }

  /**
   * 自動で覚える競合の数を変える（管理者だけ。呼ぶ側が確かめる）。次に探すときから効く。
   *
   * @returns 変えられなければ理由
   */
  async setAutoMax(who: CompetitorViewer, value: number): Promise<string | null> {
    return this.setSettings(who, { autoMax: value });
  }

  /**
   * 競合の分析の設定を変える（管理者だけ。呼ぶ側が確かめる）。自動で覚える数（1〜20）と、定期の見回りの間隔（第36.19節）。
   *
   * @returns 変えられなければ理由
   */
  async setSettings(who: CompetitorViewer, patch: { autoMax?: number; watch?: string }): Promise<string | null> {
    const next: Partial<CompetitorSettings> = {};
    if (patch.autoMax !== undefined) {
      const n = Math.round(patch.autoMax);
      if (!Number.isFinite(n) || n < COMPETITORS_AUTO_RANGE.min || n > COMPETITORS_AUTO_RANGE.max) {
        return `自動で覚える数は ${COMPETITORS_AUTO_RANGE.min}〜${COMPETITORS_AUTO_RANGE.max} 社です`;
      }
      next.autoMax = n;
    }
    if (patch.watch !== undefined) {
      if (patch.watch !== 'monthly' && patch.watch !== 'weekly' && patch.watch !== 'off') return '見回りの間隔は 毎月・毎週・しない のどれかです';
      next.watch = patch.watch as CompetitorWatchInterval;
    }
    const settings = await this.deps.repo.getTenantSettings(who.tenantId);
    await this.deps.repo.saveTenantSettings(who.tenantId, 'competitors', { ...settings.competitors, ...next }, who.userId);
    await this.audit(who, 'competitor.settings', 'settings', next);
    return null;
  }

  /** 地図の鍵を外す（管理者だけ）。 */
  async removeMapKey(who: CompetitorViewer): Promise<void> {
    await this.deps.repo.deleteTenantCredential(who.tenantId, 'places');
    const settings = await this.deps.repo.getTenantSettings(who.tenantId);
    await this.deps.repo.saveTenantSettings(who.tenantId, 'competitors', { ...settings.competitors, mapKey: null }, who.userId);
    await this.audit(who, 'competitor.map_key_remove', 'map-key', {});
  }

  private async audit(who: CompetitorViewer, action: string, id: string, detail: Record<string, unknown>): Promise<void> {
    await this.deps.repo.appendAudit({
      id: randomUUID(), tenantId: who.tenantId, actorType: who.userId === COMPETITOR_SYSTEM ? 'system' : 'user', actorId: who.userId === COMPETITOR_SYSTEM ? 'competitor-watch' : who.userId,
      action, targetType: 'competitor', targetId: id,
      detail, occurredAt: new Date().toISOString(),
    });
  }

  // ---- 見る ------------------------------------------------------------------------------

  /**
   * 画面の全体（自社の像・競合・動いている作業）。地図で見つけた競合の名前と Web サイトは、ここで引き直す。
   */
  async overview(who: CompetitorViewer): Promise<CompetitorOverview> {
    const { store } = this.deps;
    await store.forgetLocations(who.tenantId, new Date(Date.now() - LOCATION_DAYS * 86_400_000).toISOString());
    const [profile, rows, counts, job, lastJob] = await Promise.all([
      store.profile(who.tenantId), store.list(who.tenantId), store.factCounts(who.tenantId), store.activeJob(who.tenantId), store.lastJob(who.tenantId),
    ]);
    const { client, note } = await this.places(who.tenantId);
    const watching = rows.filter((c) => c.status === 'watching');
    const competitors = await Promise.all(watching.map((c) => this.view(c, profile, counts.get(c.id) ?? 0, client)));
    competitors.sort((a, b) => (a.distanceM ?? Number.MAX_SAFE_INTEGER) - (b.distanceM ?? Number.MAX_SAFE_INTEGER));
    const self = profile?.selfPlaceId && client ? await client.details(profile.selfPlaceId).catch(() => null) : null;
    const selfRating = self?.rating != null && self.ratingCount != null ? { rating: self.rating, count: self.ratingCount } : null;
    const interval = competitorWatch((await this.deps.repo.getTenantSettings(who.tenantId)).competitors);
    const nextWatchAt = profile && interval !== 'off' ? await this.nextWatchAt(who.tenantId, interval, new Date()) : null;
    return { profile: profile ? publicProfile(profile) : null, competitors, job: job ? publicJob(job) : null, lastJob: lastJob ? publicJob(lastJob) : null, mapNote: note, selfRating, nextWatchAt };
  }

  /** 次の定期の見回りの日時（今の回をまだ見回っていなければ今の回の始まり、見回っていれば次の回の始まり）。 */
  private async nextWatchAt(tenantId: string, interval: 'monthly' | 'weekly', now: Date): Promise<string> {
    const start = watchPeriodStart(interval, now);
    const last = await this.deps.store.lastFullRunAt(tenantId);
    return (last && last >= start.toISOString() ? nextWatchStart(interval, now) : start).toISOString();
  }

  /**
   * 定期の見回りの番か確かめ、番なら作業を受け付ける（ワーカーが呼ぶ。第36.19節）。
   * 会社情報の住所か Web サイトが自社の像と違えば、すぐに探し直す。前に探してから 90 日を過ぎていれば、見回りの代わりに探し直す。
   *
   * @returns 受け付けた作業の種類。番でなければ `null`
   */
  async scheduleIfDue(tenantId: string, now: Date = new Date()): Promise<'discover' | 'check' | null> {
    const { store, repo } = this.deps;
    const settings = await repo.getTenantSettings(tenantId);
    if (!settings.competitors.enabled) return null;
    const profile = await store.profile(tenantId);
    // 一度も探していない会社では行わない
    if (!profile) return null;
    if (await store.activeJob(tenantId)) return null;
    const enqueue = async (kind: 'discover' | 'check', reason: string) => {
      await store.addJob(tenantId, { kind, args: { scheduled: true, reason }, requestedBy: COMPETITOR_SYSTEM });
      return kind;
    };
    const addressChanged = !!settings.company.address && settings.company.address !== profile.location;
    const websiteChanged = !!settings.company.website && hostOf(settings.company.website) !== hostOf(profile.website);
    if (addressChanged || websiteChanged) {
      // 同じ理由で何度も探し直さないよう、最後に探してから 1 時間は待つ
      const lastDiscover = await store.lastDiscoverAt(tenantId);
      if (!lastDiscover || lastDiscover < new Date(now.getTime() - 3_600_000).toISOString()) return enqueue('discover', 'company');
    }
    const interval = competitorWatch(settings.competitors);
    if (interval === 'off') return null;
    const start = watchPeriodStart(interval, now);
    const last = await store.lastFullRunAt(tenantId);
    if (last && last >= start.toISOString()) return null;
    const lastDiscover = await store.lastDiscoverAt(tenantId);
    const stale = !lastDiscover || lastDiscover < new Date(now.getTime() - REDISCOVER_DAYS * 86_400_000).toISOString();
    return enqueue(stale ? 'discover' : 'check', stale ? 'rediscover' : 'watch');
  }

  /** 画面と秘書に返す 1 社の形（名前・Web サイトは地図から引き直す）。 */
  private async view(c: StoredCompetitor, profile: CompetitorProfile | null, factCount: number, client: PlacesClient | null): Promise<Competitor> {
    let name = c.name;
    let url = c.url;
    let attributions: string[] = [];
    let rating: number | null = null;
    let ratingCount: number | null = null;
    // 地図の店は、名前・Web サイト・評価と件数を表示のたびに引き直す（残さない。第36.13節）
    if (c.placeId && client) {
      const hit = await client.details(c.placeId).catch(() => null);
      if (hit) {
        name ||= hit.name;
        url ||= hit.website;
        attributions = hit.attributions;
        rating = hit.rating;
        ratingCount = hit.ratingCount;
      }
    }
    const geo = profile?.geo;
    const distance = geo && c.lat !== null && c.lng !== null ? distanceM(geo, { lat: c.lat, lng: c.lng }) : null;
    return {
      id: c.id, origin: c.origin, name, url, distanceM: distance, reason: c.reason, status: c.status, lastReadAt: c.lastReadAt,
      pagesRead: c.pagesRead, pagesFailed: c.pagesFailed, readNote: c.readNote, factCount, attributions, rating, ratingCount, createdBy: c.createdBy, createdAt: c.createdAt,
    };
  }

  /** 1 社（自社なら `null`）の事実（新しい回から）。 */
  async facts(who: CompetitorViewer, competitorId: string | null): Promise<CompetitorFact[]> {
    if (competitorId && !(await this.deps.store.get(who.tenantId, competitorId))) return [];
    return (await this.deps.store.facts(who.tenantId, competitorId)).map(({ pageHash: _h, ...f }) => f);
  }

  /** レポート（新しい順）。 */
  async reports(who: CompetitorViewer, limit = 12): Promise<CompetitorReport[]> {
    return this.deps.store.reports(who.tenantId, Math.min(50, Math.max(1, limit)));
  }

  /**
   * 名前か URL の言葉で、見ている競合を探す（秘書の「〇〇店とうちの違いは？」「〇〇は競合じゃない」）。
   */
  async find(who: CompetitorViewer, q: string): Promise<Competitor[]> {
    const term = q.trim().toLowerCase();
    const all = (await this.overview(who)).competitors;
    if (!term) return all;
    return all.filter((c) => c.name.toLowerCase().includes(term) || c.url.toLowerCase().includes(term) || term.includes(c.name.toLowerCase()) && c.name.length >= 2);
  }

  // ---- 足す・外す --------------------------------------------------------------------------

  /**
   * 人が競合を入れる（URL か店の名前。第36.5節）。名前なら地図か推論で Web サイトを引き、トップを読んで確かめる。
   * 足したら、その 1 社を読む作業を受け付ける。
   *
   * @returns 足した競合の ID、だめなら理由
   */
  async add(who: CompetitorViewer, input: string): Promise<{ id: string; jobId: string } | { error: string }> {
    const text = input.trim().slice(0, 300);
    if (!text) return { error: 'URL か店の名前を入れてください' };
    const { store } = this.deps;
    const rows = await store.list(who.tenantId);
    const max = competitorsMax(competitorAutoMax((await this.deps.repo.getTenantSettings(who.tenantId)).competitors));
    if (rows.filter((c) => c.status === 'watching').length >= max) return { error: `競合は ${max} 社までです。外してから入れてください` };
    if (this.deps.externalAllowed && !(await this.deps.externalAllowed(who.tenantId))) return { error: '社内の機械だけで AI を使う会社では、競合の分析を使えません' };
    const fetcher = this.fetcher(who.tenantId);
    const robots = this.robotsFor(who.tenantId, fetcher);
    let newRow: { name: string; url: string; placeId: string | null; lat: number | null; lng: number | null } | null = null;
    if (/^https?:\/\//i.test(text)) {
      const checked = checkUrl(text);
      if (typeof checked === 'string') return { error: checked };
      newRow = { name: '', url: checked.toString(), placeId: null, lat: null, lng: null };
    } else {
      const profile = await store.profile(who.tenantId);
      const { client } = await this.places(who.tenantId);
      if (client) {
        const geo = profile?.geo;
        const hits = await client.search(text, geo ? { lat: geo.lat, lng: geo.lng, radiusM: profile?.area.radiusM ?? 5000 } : undefined).catch(() => [] as PlaceHit[]);
        const hit = hits[0];
        // 地図の名前・URL は残さず、place ID と本人が入れた名前だけを残す（第36.13節）
        if (hit) newRow = { name: text, url: '', placeId: hit.id, lat: hit.lat, lng: hit.lng };
      }
      if (!newRow) {
        const llm = await this.deps.llmFor(who.tenantId).catch(() => null);
        const url = await findUrlByName(llm, text, profile?.location ?? '');
        if (!url) return { error: `「${text}」の Web サイトが見つかりません。URL を入れてください` };
        newRow = { name: text, url, placeId: null, lat: null, lng: null };
      }
    }
    if (newRow.url) {
      const origin = new URL(newRow.url).origin;
      if (rows.some((c) => c.url && new URL(c.url).origin === origin && c.status === 'watching')) return { error: 'その Web サイトはもう競合に入っています' };
      // 外したものを人が入れ直したら、見ている状態に戻す
      const removed = rows.find((c) => c.url && new URL(c.url).origin === origin && c.status === 'removed');
      if (removed) {
        await store.update(who.tenantId, removed.id, { status: 'watching', reason: '人が入れた' });
        const jobId = await store.addJob(who.tenantId, { kind: 'check', args: { competitorId: removed.id }, requestedBy: who.userId });
        await this.audit(who, 'competitor.add', removed.id, { origin: removed.origin });
        return { id: removed.id, jobId };
      }
      const top = await readSite({ fetcher, robots, llm: null, ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}) }, newRow.url, 1);
      if (top.read === 0) return { error: `その Web サイトを読めません（${top.note || '届きませんでした'}）` };
      if (!newRow.name) newRow.name = top.pages[0]!.title.split(/[|｜\-–—:：]/)[0]!.trim().slice(0, 60) || new URL(newRow.url).hostname;
    } else if (newRow.placeId) {
      const same = rows.find((c) => c.placeId === newRow!.placeId);
      if (same?.status === 'watching') return { error: 'その店はもう競合に入っています' };
      if (same) {
        await store.update(who.tenantId, same.id, { status: 'watching', reason: '人が入れた' });
        const jobId = await store.addJob(who.tenantId, { kind: 'check', args: { competitorId: same.id }, requestedBy: who.userId });
        await this.audit(who, 'competitor.add', same.id, { origin: same.origin });
        return { id: same.id, jobId };
      }
    }
    const id = await store.add(who.tenantId, { origin: 'manual', reason: '人が入れた', createdBy: who.userId, ...newRow });
    const jobId = await store.addJob(who.tenantId, { kind: 'check', args: { competitorId: id }, requestedBy: who.userId });
    await this.audit(who, 'competitor.add', id, { origin: 'manual', byMap: !!newRow.placeId });
    return { id, jobId };
  }

  /** 競合を外す（次に自動で探しても入れない。第36.5節）。 */
  async remove(who: CompetitorViewer, id: string): Promise<boolean> {
    const c = await this.deps.store.get(who.tenantId, id);
    if (!c || c.status === 'removed') return false;
    await this.deps.store.update(who.tenantId, id, { status: 'removed' });
    await this.audit(who, 'competitor.remove', id, { origin: c.origin });
    return true;
  }

  // ---- 作業を受け付ける -------------------------------------------------------------------

  /**
   * 競合を探す作業を受け付ける（自社の像をまとめ、探し、読んでレポートを作る）。動いている作業があれば、それを返す。
   *
   * @param area 商圏の上書き（「半径 2 km で」「全国で」）。`undefined` なら変えない、`null` なら AI に戻す
   */
  async requestDiscover(who: CompetitorViewer, area?: { local: boolean; radiusM: number | null } | null): Promise<{ jobId: string; already: boolean }> {
    if (area !== undefined) {
      const settings = await this.deps.repo.getTenantSettings(who.tenantId);
      const radius = area?.local && area.radiusM ? Math.min(50_000, Math.max(300, Math.round(area.radiusM))) : null;
      await this.deps.repo.saveTenantSettings(who.tenantId, 'competitors', { ...settings.competitors, areaOverride: area ? { local: area.local, radiusM: area.local ? radius ?? 2000 : null } : null }, who.userId);
    }
    return this.enqueue(who, 'discover', {});
  }

  /** 今すぐ見回る作業を受け付ける（自社と競合を読み、レポートを作る）。 */
  async requestCheck(who: CompetitorViewer): Promise<{ jobId: string; already: boolean }> {
    return this.enqueue(who, 'check', {});
  }

  private async enqueue(who: CompetitorViewer, kind: CompetitorJob['kind'], args: Record<string, unknown>): Promise<{ jobId: string; already: boolean }> {
    const active = await this.deps.store.activeJob(who.tenantId);
    if (active && active.kind === kind && !active.args['competitorId']) return { jobId: active.id, already: true };
    const jobId = await this.deps.store.addJob(who.tenantId, { kind, args, requestedBy: who.userId });
    return { jobId, already: false };
  }

  /**
   * いまある事実から、その場のレポートを作る（読み直さない。第36.8節）。
   */
  async makeReport(who: CompetitorViewer, now = new Date()): Promise<CompetitorReport> {
    return (await this.writeReportNow(who, now)).report;
  }

  /** レポートを作り、動きのはじめの 3 件（知らせに使う）も返す。 */
  private async writeReportNow(who: CompetitorViewer, now = new Date()): Promise<{ report: CompetitorReport; highlights: string[] }> {
    const { store } = this.deps;
    const [profile, rows] = await Promise.all([store.profile(who.tenantId), store.list(who.tenantId)]);
    const { client } = await this.places(who.tenantId);
    const subjects: ReportSubject[] = [];
    for (const c of rows.filter((x) => x.status === 'watching')) {
      const v = await this.view(c, profile, 0, client);
      const all = await store.facts(who.tenantId, c.id);
      const periods = [...new Set(all.map((f) => f.period))].sort().reverse();
      const pick = (p: string | undefined) => all.filter((f) => f.period === p).map((f) => ({ kind: f.kind, text: f.text, sourceUrl: f.sourceUrl }));
      // 変わったページ（印が前の回と違う・新しいページ）。印の無い古い回なら事実の文の違いで数える
      const pages = await store.pages(who.tenantId, c.id);
      const nowPages = pages.filter((p) => p.period === periods[0]);
      const prevPages = new Map(pages.filter((p) => p.period === periods[1]).map((p) => [p.url, p.hash]));
      const changedUrls = nowPages.length && prevPages.size ? nowPages.filter((p) => prevPages.get(p.url) !== p.hash).map((p) => p.url) : undefined;
      subjects.push({
        name: v.name || 'Google Maps の店（名前を引けませんでした）', url: v.url, distanceM: v.distanceM, rating: v.rating, ratingCount: v.ratingCount,
        facts: pick(periods[0]), previous: pick(periods[1]), ...(changedUrls ? { changedUrls } : {}), readNote: c.lastReadAt ? c.readNote : 'まだ読んでいません',
      });
    }
    const llm = await this.deps.llmFor(who.tenantId).catch(() => null);
    const names = subjects.map((x) => x.name);
    const [written, themes, mentions, announcementIdeas] = await Promise.all([
      writeReport(llm, profile, subjects), suggestThemes(llm, profile, subjects, names), this.inquiryMentions(who.tenantId, names, now),
      suggestAnnouncements(llm, profile, subjects, names),
    ]);
    // 問い合わせで名前が出た競合は、件数だけを添える（誰からの問い合わせかは入れない。第36.9節）
    const text = mentions.length
      ? `${written}\n\n## 問い合わせで名前が出た競合\n${mentions.map((m) => `- ${m.name}: ${m.count} 件`).join('\n')}`
      : written;
    const moved = subjects.flatMap((x) => movesOf(x).map((f) => ({ name: x.name, f })));
    const moves = moved.map((m) => `${m.name}: ${m.f.text}`);
    // 変わった事実の種類ごとの数（Web の振り返りの月の便りに添える。第36.21節）
    const changeKinds: Partial<Record<CompetitorFactKind, number>> = {};
    for (const { f } of moved) changeKinds[f.kind] = (changeKinds[f.kind] ?? 0) + 1;
    const report = { period: competitorPeriodOf(now), text, changes: moves.length, themes, announcementIdeas, changeKinds, createdBy: who.userId };
    const id = await store.addReport(who.tenantId, report);
    await this.audit(who, 'competitor.report', id, { competitors: subjects.length, changes: moves.length });
    return { report: { ...report, id, createdAt: new Date().toISOString() }, highlights: moves.slice(0, 3) };
  }

  /**
   * 前のレポートの後（無ければ 31 日）の問い合わせのうち、「どこで知ったか」に競合の名前が出たものの数（第36.9節）。
   */
  private async inquiryMentions(tenantId: string, names: string[], now: Date): Promise<{ name: string; count: number }[]> {
    if (!this.deps.inquirySources) return [];
    const [prev] = await this.deps.store.reports(tenantId, 1);
    const since = prev?.createdAt ?? new Date(now.getTime() - 31 * 86_400_000).toISOString();
    const sources = await this.deps.inquirySources(tenantId, since).catch(() => [] as string[]);
    if (!sources.length) return [];
    const out: { name: string; count: number }[] = [];
    for (const name of names) {
      const core = name.replace(/株式会社|有限会社|合同会社|医療法人(社団|財団)?|（.*?）|\(.*?\)|\s/g, '');
      if (core.length < 3) continue;
      const count = sources.filter((src) => src.replace(/\s/g, '').includes(core)).length;
      if (count) out.push({ name, count });
    }
    return out;
  }

  // ---- 作業を行う（ワーカー） -------------------------------------------------------------

  /**
   * 受け付けた作業を 1 つ行う。
   *
   * @returns 終わったときの一言
   */
  async runJob(tenantId: string, job: StoredJob): Promise<{ ok: boolean; message: string }> {
    const who = { tenantId, userId: job.requestedBy };
    if (this.deps.externalAllowed && !(await this.deps.externalAllowed(tenantId))) {
      return { ok: false, message: '社内の機械だけで AI を使う会社では、競合の分析を使えません' };
    }
    const progress = (m: string) => this.deps.store.setJobMessage(tenantId, job.id, m).catch(() => undefined);
    const scheduled = job.args['scheduled'] === true;
    if (job.kind === 'discover') return this.discover(who, progress, { scheduled });
    const one = typeof job.args['competitorId'] === 'string' ? job.args['competitorId'] : '';
    return one ? this.checkOne(who, one) : this.checkAll(who, progress, { scheduled });
  }

  /**
   * 定期の見回りの結果を、利用範囲の中の管理者に届ける（第36.19節。個人設定で切っていれば届けない）。
   *
   * @param highlights 動きのはじめの 3 件（「競合の名前: 事実」）
   */
  private async deliver(tenantId: string, changes: number, highlights: string[], now: Date): Promise<number> {
    const { repo } = this.deps;
    const settings = await repo.getTenantSettings(tenantId);
    const day = dateIn('Asia/Tokyo', now);
    const title = `競合の動き（${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))} の見回り）`;
    const body = changes ? `前の回から ${changes} 件の動きがありました。${highlights.join('／')}` : '前の回から大きな動きはありませんでした';
    let sent = 0;
    for (const u of await repo.listUsers(tenantId)) {
      if (u.status !== 'active' || !u.roles.includes('admin')) continue;
      const groups = await repo.listUserGroupIds(tenantId, u.id);
      if (!canUseAgent(settings.access, COMPETITORS_EXTENSION_ID, u.id, groups)) continue;
      const prefs = await repo.getUserSettings(tenantId, u.id).catch(() => null);
      if (prefs?.notifications.kinds.competitor === false) continue;
      await repo.createNotification({
        id: randomUUID(), tenantId, userId: u.id, kind: 'competitor', title, body: body.slice(0, 300), runId: null, readAt: null, createdAt: now.toISOString(),
      }).then(() => { sent += 1; }).catch((err: unknown) => this.log.warn('競合の動きを知らせられませんでした', { error: String(err) }));
    }
    return sent;
  }

  /** 読むのに使うもの。 */
  private async reader(tenantId: string) {
    const fetcher = this.fetcher(tenantId);
    const llm = await this.deps.llmFor(tenantId).catch(() => null);
    return { fetcher, robots: this.robotsFor(tenantId, fetcher), llm, ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}) };
  }

  /** 自社の像をまとめる（自社のサイトを読む。地図で自社の位置を引く）。 */
  private async buildProfile(who: CompetitorViewer, progress: (m: string) => Promise<void>): Promise<BuiltProfile> {
    const settings = await this.deps.repo.getTenantSettings(who.tenantId);
    const tenant = await this.deps.repo.findTenantById(who.tenantId);
    const companyName = settings.company.legalName || settings.company.shortName || tenant?.name || '';
    const address = settings.company.address;
    const { client, note } = await this.places(who.tenantId);
    let mapNote = note;
    let selfPlace: PlaceHit | null = null;
    let geo: { lat: number; lng: number } | null = null;
    if (client) {
      try {
        const hits = await client.search(`${companyName} ${address}`.trim());
        // 地図の名前はかな書き・略称のことがあるため、Web サイトが会社情報と同じものを先に自社とみなす
        const own = hostOf(settings.company.website);
        selfPlace = (own ? hits.find((h) => hostOf(h.website) === own) : undefined) ?? hits.find((h) => sameName(h.name, companyName)) ?? null;
        if (selfPlace?.lat != null && selfPlace.lng != null) geo = { lat: selfPlace.lat, lng: selfPlace.lng };
        if (!geo && address) {
          const at = (await client.search(address))[0];
          if (at?.lat != null && at.lng != null) geo = { lat: at.lat, lng: at.lng };
        }
      } catch (err) {
        mapNote = err instanceof PlacesUnavailableError ? err.message : '地図から自社の場所を引けませんでした';
      }
    }
    // 自社の Web サイトは会社情報を先に。無ければ地図で見つけた自社のもの（第36.4節）
    const website = settings.company.website || selfPlace?.website || '';
    const r = await this.reader(who.tenantId);
    let reading: SiteReading = { pages: [], read: 0, failed: 0, note: '' };
    if (website) {
      await progress('自社の Web サイトを読んでいます');
      reading = await readSite(r, website);
    }
    const summary = await summarizeProfile(r.llm, { companyName, address, website, pages: reading.pages, told: '' });
    const override = settings.competitors.areaOverride;
    const decided: AreaDecision = await decideArea(r.llm, summary);
    const area: AreaDecision = override
      ? { ...decided, local: override.local, radiusM: override.local ? override.radiusM ?? decided.radiusM ?? 2000 : null, reason: override.local ? '指定された半径で探します' : '全国で探すように言われたため' }
      : decided;
    if (reading.read > 0) await this.keepFacts(who.tenantId, null, competitorPeriodOf(new Date()), reading, r.llm);
    const profile: CompetitorProfile = {
      ...summary, area: { local: area.local, radiusM: area.radiusM, keyword: area.keyword, reason: area.reason },
      pagesRead: reading.read, pagesFailed: reading.failed, updatedAt: new Date().toISOString(),
      geo: geo ? { ...geo, at: new Date().toISOString() } : null,
      selfPlaceId: selfPlace?.id ?? null,
    };
    await this.deps.store.saveProfile(who.tenantId, profile);
    const missingGeo = profile.area.local && !geo && !mapNote ? '地図から自社の場所を引けませんでした（会社情報の住所を確かめてください）' : mapNote;
    return { profile, selfPlaceId: selfPlace?.id ?? null, places: client, mapNote: missingGeo, types: area.types };
  }

  /** 競合を探す（第36.5節）。探したら、見ている競合を読んでレポートを作る。 */
  private async discover(who: CompetitorViewer, progress: (m: string) => Promise<void>, opts: { scheduled?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
    const { store } = this.deps;
    await progress('自社の像をまとめています');
    const built = await this.buildProfile(who, progress);
    const { profile, selfPlaceId, places, mapNote } = built;
    const rows = await store.list(who.tenantId);
    const manual = rows.filter((c) => c.origin === 'manual' && c.status === 'watching').length;
    const autoMax = competitorAutoMax((await this.deps.repo.getTenantSettings(who.tenantId)).competitors);
    const room = Math.max(0, Math.min(autoMax, competitorsMax(autoMax) - manual));
    const removedPlaces = new Set(rows.filter((c) => c.status === 'removed' && c.placeId).map((c) => c.placeId!));
    const removedOrigins = new Set(rows.filter((c) => c.status === 'removed' && c.url).map((c) => safeOrigin(c.url)));
    const manualOrigins = new Set(rows.filter((c) => c.origin === 'manual' && c.url).map((c) => safeOrigin(c.url)));
    const manualPlaces = new Set(rows.filter((c) => c.origin === 'manual' && c.placeId).map((c) => c.placeId!));
    const r = await this.reader(who.tenantId);
    const settings = await this.deps.repo.getTenantSettings(who.tenantId);
    const tenant = await this.deps.repo.findTenantById(who.tenantId);
    const companyName = settings.company.legalName || settings.company.shortName || tenant?.name || '';
    const keep: string[] = [];
    let note = mapNote;
    await progress('競合を探しています');
    if (profile.area.local) {
      if (!places || !profile.geo) {
        note = note || '地図から探せませんでした';
      } else {
        let hits: PlaceHit[] = [];
        const fromKeyword = new Set<string>();
        const radius = profile.area.radiusM ?? 2000;
        try {
          // 種類（医院・店など）は広すぎることがあるため、業種の言葉（例: 歯科）での検索と合わせる
          const byKeyword = await places.search(profile.area.keyword || profile.business, { lat: profile.geo.lat, lng: profile.geo.lng, radiusM: radius });
          const byType = built.types.length ? await places.nearby(profile.geo, radius, built.types) : [];
          const seen = new Set<string>();
          hits = [...byKeyword, ...byType].filter((h) => (seen.has(h.id) ? false : (seen.add(h.id), true)));
          for (const h of byKeyword) fromKeyword.add(h.id);
        } catch (err) {
          note = err instanceof PlacesUnavailableError ? err.message : '地図から探せませんでした';
        }
        const ownHosts = new Set([hostOf(settings.company.website), hostOf(profile.website)].filter(Boolean));
        const pool = hits.filter((h) => h.id !== selfPlaceId && !removedPlaces.has(h.id) && !manualPlaces.has(h.id) && !sameName(h.name, companyName)
          && !(h.website && ownHosts.has(hostOf(h.website)))
          && h.lat !== null && h.lng !== null && distanceM(profile.geo!, { lat: h.lat, lng: h.lng }) <= radius)
          // 業種の言葉で見つけたものを先に、それぞれ近い順（種類だけで見つけたものは業種が違うことが多い）
          .sort((a, b) => (Number(!fromKeyword.has(a.id)) - Number(!fromKeyword.has(b.id)))
            || distanceM(profile.geo!, { lat: a.lat!, lng: a.lng! }) - distanceM(profile.geo!, { lat: b.lat!, lng: b.lng! }))
          .slice(0, Math.max(20, room * 2));
        const candidates: Candidate[] = pool.map((h) => ({ name: h.name, url: h.website, primaryType: h.primaryType, summary: '' }));
        const kept = (await checkCandidates(r.llm, profile, companyName, candidates, profile.website)).slice(0, room);
        for (const k of kept) {
          const h = pool[k.index]!;
          keep.push(await store.add(who.tenantId, { origin: 'map', placeId: h.id, name: '', url: '', lat: h.lat, lng: h.lng, reason: k.reason, createdBy: who.userId }));
        }
      }
    } else {
      const exclude = rows.map((c) => c.name || c.url).filter(Boolean);
      const suggested = await suggestCompetitors(r.llm, profile, companyName, exclude, room);
      const candidates: Candidate[] = [];
      for (const sgt of suggested) {
        const origin = safeOrigin(sgt.url);
        if (!origin || removedOrigins.has(origin) || manualOrigins.has(origin)) continue;
        // 挙げた会社が実在するかを、相手のトップのページで確かめる（間を空けて 1 本ずつ）
        if (r.fetcher.delayMs > 0) await (this.deps.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms))))(r.fetcher.delayMs);
        const top = await readSite({ ...r, llm: null }, sgt.url, 1);
        if (top.read === 0) continue;
        candidates.push({ name: sgt.name, url: top.pages[0]!.url, primaryType: '', summary: `${top.pages[0]!.title} ${top.pages[0]!.description}` });
      }
      const kept = (await checkCandidates(r.llm, profile, companyName, candidates)).slice(0, room);
      for (const k of kept) {
        const c = candidates[k.index]!;
        const same = rows.find((x) => x.url && safeOrigin(x.url) === safeOrigin(c.url) && x.status === 'watching');
        keep.push(same ? same.id : await store.add(who.tenantId, { origin: 'ai', placeId: null, name: c.name, url: c.url, lat: null, lng: null, reason: k.reason, createdBy: who.userId }));
      }
      if (suggested.length === 0) note = note || '商圏の無い業種のため、AI が同業を挙げようとしましたが、確かな会社を挙げられませんでした。競合の URL を入れてください';
    }
    const dropped = await store.dropAutoExcept(who.tenantId, keep);
    await this.audit(who, 'competitor.discover', 'discover', { local: profile.area.local, radiusM: profile.area.radiusM, found: keep.length, dropped });
    const checked = await this.checkAll(who, progress, { quietIfNone: true, ...(opts.scheduled ? { scheduled: true } : {}) });
    const found = `競合を ${keep.length} 社見つけました${note ? `（${note}）` : ''}`;
    if (!opts.scheduled) await this.notify(who, '競合を探し終えました', found);
    return { ok: true, message: `${found}。${checked.message}` };
  }

  /**
   * 読んだページから、その回の事実とページの印を残す（第36.19節）。印が前の回と同じページは、前の回の事実をそのまま使い、
   * 推論に取り出し直させない（言い回しの揺れを変化と取り違えないため）。変わったページ・新しいページだけ取り出す。
   */
  private async keepFacts(tenantId: string, competitorId: string | null, period: string, reading: SiteReading, llm: LlmProvider | null): Promise<void> {
    const { store } = this.deps;
    const prevPages = (await store.pages(tenantId, competitorId)).filter((p) => p.period !== period);
    const prevPeriod = prevPages[0]?.period;
    const prevHash = new Map(prevPages.filter((p) => p.period === prevPeriod).map((p) => [p.url, p.hash]));
    const prevFacts = prevPeriod ? (await store.facts(tenantId, competitorId)).filter((f) => f.period === prevPeriod) : [];
    const same = reading.pages.filter((p) => prevHash.get(p.url) === p.hash);
    const changed = reading.pages.filter((p) => prevHash.get(p.url) !== p.hash);
    const sameUrls = new Set(same.map((p) => p.url));
    const reused = prevFacts.filter((f) => sameUrls.has(f.sourceUrl)).map((f) => ({ kind: f.kind, text: f.text, sourceUrl: f.sourceUrl, pageHash: f.pageHash }));
    const fresh = changed.length ? (await extractFacts(llm, changed)).map((f) => ({ ...f, pageHash: changed.find((p) => p.url === f.sourceUrl)?.hash ?? '' })) : [];
    await store.replaceFacts(tenantId, competitorId, period, [...reused, ...fresh]);
    await store.replacePages(tenantId, competitorId, period, reading.pages.map((p) => ({ url: p.url, hash: p.hash })));
    await store.prune(tenantId, competitorId, KEEP_PERIODS);
  }

  /** 1 社を読み、事実を置き換える。 */
  private async readOne(who: CompetitorViewer, c: StoredCompetitor, period: string): Promise<{ read: number; failed: number }> {
    const { store } = this.deps;
    const r = await this.reader(who.tenantId);
    let url = c.url;
    if (c.placeId) {
      const { client } = await this.places(who.tenantId);
      const hit = client ? await client.details(c.placeId).catch(() => null) : null;
      if (hit) {
        url ||= hit.website;
        // 位置は 30 日まで持てる。読むたびに引き直す
        if (hit.lat !== null && hit.lng !== null) await store.update(who.tenantId, c.id, { lat: hit.lat, lng: hit.lng });
      }
    }
    if (!url) {
      await store.update(who.tenantId, c.id, { lastReadAt: new Date().toISOString(), pagesRead: 0, pagesFailed: 0, readNote: 'Web サイトなし' });
      return { read: 0, failed: 0 };
    }
    const reading = await readSite(r, url);
    if (reading.read > 0) await this.keepFacts(who.tenantId, c.id, period, reading, r.llm);
    // 読めなかったときは、前の回の事実を今の事実として扱わない（今の回の事実は作らない）
    await store.update(who.tenantId, c.id, { lastReadAt: new Date().toISOString(), pagesRead: reading.read, pagesFailed: reading.failed, readNote: reading.note });
    return { read: reading.read, failed: reading.failed };
  }

  /** 人が入れた 1 社を読む。 */
  private async checkOne(who: CompetitorViewer, id: string): Promise<{ ok: boolean; message: string }> {
    const c = await this.deps.store.get(who.tenantId, id);
    if (!c || c.status !== 'watching') return { ok: true, message: '外された競合のため、読みませんでした' };
    const r = await this.readOne(who, c, competitorPeriodOf(new Date()));
    await this.audit(who, 'competitor.check', id, { pages: r.read, failed: r.failed });
    return { ok: true, message: `${r.read} ページを読みました${r.failed ? `（${r.failed} ページは読めませんでした）` : ''}` };
  }

  /** 自社と見ている競合を読み、レポートを作る。 */
  private async checkAll(who: CompetitorViewer, progress: (m: string) => Promise<void>, opts: { quietIfNone?: boolean; scheduled?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
    const { store } = this.deps;
    const period = competitorPeriodOf(new Date());
    const watching = (await store.list(who.tenantId)).filter((c) => c.status === 'watching');
    let read = 0;
    let failed = 0;
    if (!opts.quietIfNone) {
      // 見回りでは自社のサイトも読み直し、自社の像を直す（探すときは buildProfile で読んでいる）
      await progress('自社の像をまとめています');
      await this.buildProfile(who, progress);
    }
    for (const [i, c] of watching.entries()) {
      await progress(`競合のサイトを読んでいます（${i + 1}/${watching.length}）`);
      const r = await this.readOne(who, c, period);
      read += r.read;
      failed += r.failed;
    }
    await progress('レポートを書いています');
    const { report, highlights } = await this.writeReportNow(who);
    await this.audit(who, 'competitor.check', 'all', { competitors: watching.length, pages: read, failed, scheduled: !!opts.scheduled });
    const message = `${watching.length} 社を見回り、${read} ページを読みました${failed ? `（${failed} ページは読めませんでした）` : ''}。レポートを作りました`;
    if (opts.scheduled) await this.deliver(who.tenantId, report.changes, highlights, new Date());
    else if (!opts.quietIfNone) await this.notify(who, '競合を見回りました', `${message}${report.changes ? `。前の回から ${report.changes} 件変わっていました` : ''}`);
    return { ok: true, message };
  }

  /** 頼んだ人に知らせる（個人設定で切っていれば知らせない）。 */
  private async notify(who: CompetitorViewer, title: string, body: string): Promise<void> {
    if (who.userId === COMPETITOR_SYSTEM) return;
    const prefs = await this.deps.repo.getUserSettings(who.tenantId, who.userId).catch(() => null);
    if (prefs?.notifications.kinds.competitor === false) return;
    await this.deps.repo.createNotification({
      id: randomUUID(), tenantId: who.tenantId, userId: who.userId, kind: 'competitor', title, body: body.slice(0, 300), runId: null, readAt: null, createdAt: new Date().toISOString(),
    }).catch((err: unknown) => this.log.warn('競合の分析の知らせを作れませんでした', { error: String(err) }));
  }
}

/** URL のホスト（www. を除く。読めなければ空）。自社の見分けに使う。 */
function hostOf(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** 画面と秘書に返す自社の像（位置は出さない）。 */
function publicProfile(p: CompetitorProfile): CompetitorProfile {
  const { geo: _g, selfPlaceId: _s, ...rest } = p;
  return rest;
}

/** 画面に返す作業（引数は出さない）。 */
function publicJob(j: StoredJob): CompetitorJob {
  return { id: j.id, kind: j.kind, status: j.status, message: j.message, requestedBy: j.requestedBy, createdAt: j.createdAt, finishedAt: j.finishedAt };
}

/**
 * 受け付けた作業を、ワーカーが 1 つずつ行う（会社ごとに 1 つずつ。プロセスで同時に 1 つ）。
 */
export class CompetitorWatch {
  private busy = false;

  constructor(private readonly deps: { service: CompetitorService; store: CompetitorStore; repo: Repository; logger?: Logger }) {}

  /**
   * 1 回分。待っている作業があれば 1 つ取り、終わるまで待たずに返す（長い作業でワーカーを止めない）。
   *
   * @param wait 終わるまで待つ（自動テスト）
   * @param now 今の日時（自動テストで、見回りの番を確かめる）
   * @returns 始めた作業の数
   */
  async tick(opts: { wait?: boolean; now?: Date } = {}): Promise<number> {
    if (this.busy) return 0;
    const { store, repo, service } = this.deps;
    const log = this.deps.logger ?? silentLogger;
    for (const tenantId of await repo.listTenantIds()) {
      const settings = await repo.getTenantSettings(tenantId).catch(() => null);
      if (!settings?.competitors.enabled) continue;
      await store.failStale(tenantId, new Date(Date.now() - STALE_MS).toISOString());
      // 定期の見回り・探し直しの番なら受け付ける（第36.19節）
      await service.scheduleIfDue(tenantId, opts.now ?? new Date()).catch((err: unknown) => log.warn('競合の見回りの番を確かめられませんでした', { tenantId, error: String(err) }));
      const job = await store.claimJob(tenantId);
      if (!job) continue;
      this.busy = true;
      const run = service.runJob(tenantId, job)
        .then((r) => store.finishJob(tenantId, job.id, r.ok ? 'done' : 'failed', r.message))
        .catch(async (err: unknown) => {
          log.warn('競合の分析の作業に失敗しました', { tenantId, kind: job.kind, error: String(err) });
          await store.finishJob(tenantId, job.id, 'failed', '途中で止まりました。もう一度頼んでください').catch(() => undefined);
        })
        .finally(() => { this.busy = false; });
      if (opts.wait) await run;
      return 1;
    }
    return 0;
  }
}
