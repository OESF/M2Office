/**
 * @file 運営の鍵（Gemini の共通の鍵）と運営の上限を、マスター管理画面の設定から読む（仕様書 第23.8.14節「マスター管理画面の設定を広げる」、Q-285）。
 *
 * API とワーカーは、起動のときに配備の設定（`GEMINI_API_KEY`・`AI_MONTHLY_LIMIT_JPY`）で始め、1 分ごとにデータベースの設定を読み直す。
 * 画面で鍵が入っていればそれを使い、無ければ配備の設定の鍵を使う。入れ替えても起動し直さずに替わる。
 * 推論と調べものは、いまの提供者に中継する代わり（`llm`・`research`）を渡す。代わりは、いまの提供者が持たない機能（画像の読み取りなど）を
 * 持たないように見せるので、呼び出し側の「この提供者では使えない」の判定はいままでどおり効く。
 * 鍵は復号してこの中だけで使い、ほかへ渡さない。自動テスト（`LLM_PROVIDER=stub`）では画面の鍵を使わない。
 */

import type pg from 'pg';
import { createPool } from '../repository/pool.js';
import type { LlmProvider } from '../llm/provider.js';
import { OpenAiCompatibleProvider } from '../llm/gemini.js';
import { GeminiResearchProvider, type ResearchProvider } from '../research/provider.js';
import type { SecretBox } from './box.js';
import type { Logger } from '../log/logger.js';
import type { GeminiModels } from './tenant-ai.js';

/** 画面で決めた運営の設定（アプリのロールが読む形。鍵は暗号化したまま）。 */
export interface PlatformAiSettings {
  keyEnc: string | null;
  keySetAt: string | null;
  /** 運営の鍵を使う会社の月の上限の既定（円）。決めていなければ `null`。 */
  tenantCapJpy: number | null;
  /** 運営の鍵での全社の月の上限（円）。決めていなければ `null`。 */
  platformCapJpy: number | null;
}

/** 設定と、運営の鍵での全社の合計を読む口。 */
export interface PlatformAiSettingsReader {
  read(): Promise<PlatformAiSettings>;
  /** 運営の鍵での全社の合計（円。`since` から）。 */
  platformTotal(since: Date): Promise<number>;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** PostgreSQL の読み口（決めた関数 `m2o_platform_ai_settings`・`m2o_ai_platform_total`）。 */
export class PostgresPlatformAiSettingsReader implements PlatformAiSettingsReader {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = createPool(connectionString, { max: 1, name: 'platform-ai' });
  }

  async read(): Promise<PlatformAiSettings> {
    const { rows } = await this.pool.query('select * from m2o_platform_ai_settings()');
    const r = rows[0];
    return {
      keyEnc: r?.gemini_key_enc ?? null, keySetAt: r?.gemini_key_set_at ? new Date(r.gemini_key_set_at).toISOString() : null,
      tenantCapJpy: num(r?.ai_tenant_cap_jpy), platformCapJpy: num(r?.ai_platform_cap_jpy),
    };
  }

  async platformTotal(since: Date): Promise<number> {
    const { rows } = await this.pool.query('select m2o_ai_platform_total($1) as total', [since]);
    return Number(rows[0]?.total ?? 0);
  }
}

/** 配備の設定（環境変数）から作った、運営の鍵の推論と調べもの（`platformAi` の答え）。 */
export interface PlatformAiBase {
  llm: LlmProvider;
  research: ResearchProvider;
  platformKey: string | null;
  testMode: boolean;
  baseUrl: string;
}

/**
 * いまの提供者に中継する代わりを作る。読むたびにいまの提供者のものを返し、関数はいまの提供者に結びつける。
 * いまの提供者が持たない機能は `undefined` に見える。
 */
function relay<T extends object>(current: () => T): T {
  return new Proxy({} as T, {
    get: (_t, p) => {
      const cur = current();
      const v = Reflect.get(cur, p, cur) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(cur) : v;
    },
    has: (_t, p) => p in current(),
  });
}

/**
 * 運営の鍵と運営の上限の出どころ。
 *
 * @remarks `start()` で読み始める（すぐ 1 回と、1 分ごと）。読めないときは、前に読めた設定のまま続ける
 */
export class PlatformAiSource {
  /** いまの運営の鍵の推論（会社の鍵が無い会社が使う）。 */
  readonly llm: LlmProvider;
  /** いまの運営の鍵の調べもの。 */
  readonly research: ResearchProvider;
  private state: { stamp: string; key: string | null; llm: LlmProvider; research: ResearchProvider };
  private settings: PlatformAiSettings = { keyEnc: null, keySetAt: null, tenantCapJpy: null, platformCapJpy: null };
  private total = { at: 0, since: 0, value: 0 };
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: {
    reader: PlatformAiSettingsReader;
    box: Pick<SecretBox, 'decrypt'>;
    /** 配備の設定から作ったもの（画面に鍵が無いときと、自動テストのとき）。 */
    base: PlatformAiBase;
    /** 配備の設定の会社ごとの上限の既定（`AI_MONTHLY_LIMIT_JPY`）。 */
    envTenantCapJpy: number | null;
    models: GeminiModels;
    logger?: Pick<Logger, 'warn' | 'info'>;
    /** 読み直す間隔（ミリ秒）。既定 1 分。 */
    intervalMs?: number;
    now?: () => number;
  }) {
    this.state = { stamp: 'env', key: deps.base.platformKey, llm: deps.base.llm, research: deps.base.research };
    this.llm = relay(() => this.state.llm);
    this.research = relay(() => this.state.research);
  }

  /** 読み始める（すぐ 1 回と、決めた間隔ごと）。プロセスの終わりを妨げない。 */
  start(): this {
    void this.refresh();
    this.timer ??= setInterval(() => void this.refresh(), this.deps.intervalMs ?? 60_000);
    this.timer.unref?.();
    return this;
  }

  /** 読むのをやめる。 */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** いまの運営の鍵（画面の鍵、無ければ配備の設定の鍵）。無ければ `null`。 */
  key(): string | null {
    return this.state.key;
  }

  /** 画面で入れた鍵を使っているか。 */
  fromScreen(): boolean {
    return this.state.stamp !== 'env';
  }

  /** 運営の鍵を使う会社の月の上限の既定（円。画面の値、無ければ配備の設定）。無ければ `null`。 */
  tenantCapJpy(): number | null {
    return this.settings.tenantCapJpy ?? this.deps.envTenantCapJpy;
  }

  /** 運営の鍵での全社の月の上限（円）。無ければ `null`。 */
  platformCapJpy(): number | null {
    return this.settings.platformCapJpy;
  }

  /** 運営の鍵での全社の合計（円。`since` から。1 分覚える）。 */
  async platformTotal(since: Date): Promise<number> {
    const now = this.deps.now ? this.deps.now() : Date.now();
    if (this.total.since === since.getTime() && now - this.total.at < (this.deps.intervalMs ?? 60_000)) return this.total.value;
    const value = await this.deps.reader.platformTotal(since);
    this.total = { at: now, since: since.getTime(), value };
    return value;
  }

  /** 手元で使った分を、覚えている合計に足す（次に読み直すまでの間の差を埋める）。 */
  addPlatformUsage(costJpy: number): void {
    this.total.value += costJpy;
  }

  /** 設定を読み直す。鍵が変わっていれば、提供者を作り直す。 */
  async refresh(): Promise<void> {
    let s: PlatformAiSettings;
    try {
      s = await this.deps.reader.read();
    } catch (err) {
      this.deps.logger?.warn('運営の AI の設定を読めませんでした。前の設定のまま続けます', { err: err instanceof Error ? err.message : String(err) });
      return;
    }
    this.settings = s;
    // 自動テストでは、画面の鍵を使わない（見本の応答のまま）
    if (this.deps.base.testMode) return;
    const stamp = s.keyEnc ? `screen:${s.keySetAt ?? ''}:${s.keyEnc.length}` : 'env';
    if (stamp === this.state.stamp) return;
    if (!s.keyEnc) {
      this.state = { stamp, key: this.deps.base.platformKey, llm: this.deps.base.llm, research: this.deps.base.research };
      this.deps.logger?.info('運営の鍵を、配備の設定のものに戻しました');
      return;
    }
    let key: string;
    try {
      key = this.deps.box.decrypt(s.keyEnc);
    } catch {
      this.deps.logger?.warn('マスター管理画面で入れた運営の鍵を復号できませんでした（暗号の鍵が違う）。配備の設定の鍵を使います');
      return;
    }
    const m = this.deps.models;
    this.state = {
      stamp, key,
      llm: new OpenAiCompatibleProvider(key, { fast: m.fast, standard: m.standard, advanced: m.advanced, fallback: m.fallback ?? '' }, this.deps.base.baseUrl, 'gemini', this.deps.logger),
      research: new GeminiResearchProvider(key, m.research),
    };
    this.deps.logger?.info('運営の鍵を、マスター管理画面で入れたものに替えました');
  }
}

/** 配備の設定の会社ごとの上限の既定（`AI_MONTHLY_LIMIT_JPY`）。無ければ `null`。 */
export function envTenantCapJpy(env: Record<string, string | undefined>): number | null {
  const raw = Number(env['AI_MONTHLY_LIMIT_JPY'] ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}
