/**
 * @file Canva とのつなぎ（仕様書 第41.19.3節）。本人の Canva を OAuth（PKCE）でつなぎ、販促物の PDF を直せるデザインとして取り込み、
 * 直したデザインを PDF と PNG で書き出して戻す。
 *
 * 運営が Canva に「公開のつなぎ」を登録し、審査を通したときに本物を使う（Q-201）。開発と自動テストは見本（`MockCanvaApi`）で動かす。
 * リフレッシュ トークンは 1 回使うと替わるため、本人ごとに順に取り直し、新しいものを暗号化して持つ。
 * 書き出したファイルは Canva の書き出しの置き場（`*.canva.com`）からだけ取る。
 */

import pg from 'pg';
import type { SecretBox } from '../secrets/box.js';
import { renderSvgPng } from '../columns/cover.js';

/** 求める範囲（デザインの読み書きだけ）。 */
export const CANVA_SCOPES = ['design:content:write', 'design:content:read', 'design:meta:read'];

/** Canva の口。 */
export const CANVA_ENDPOINTS = {
  authorize: 'https://www.canva.com/api/oauth/authorize',
  token: 'https://api.canva.com/rest/v1/oauth/token',
  revoke: 'https://api.canva.com/rest/v1/oauth/revoke',
  api: 'https://api.canva.com/rest/v1',
};

/** トークン。 */
export interface CanvaTokens {
  accessToken: string;
  refreshToken: string;
  /** アクセス トークンの残りの秒数 */
  expiresIn: number;
}

/** Canva の API（本物と見本で差し替える）。 */
export interface CanvaApi {
  /** 本人に許可を求める画面の URL。 */
  authorizeUrl(p: { redirectUri: string; state: string; codeChallenge: string }): string;
  /** 戻ってきたコードをトークンに替える。 */
  exchange(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<CanvaTokens>;
  /** リフレッシュ トークンで取り直す（リフレッシュ トークンも替わる）。 */
  refresh(refreshToken: string): Promise<CanvaTokens>;
  /** 許可を取り消す（失敗しても止めない）。 */
  revoke(refreshToken: string): Promise<void>;
  /** PDF を直せるデザインとして取り込む。 */
  importPdf(accessToken: string, title: string, pdf: Uint8Array): Promise<{ designId: string; editUrl: string }>;
  /** デザインを書き出す（面ごとのファイル。PDF は 1 つ）。 */
  exportDesign(accessToken: string, designId: string, type: 'pdf' | 'png'): Promise<Uint8Array[]>;
}

/** Canva とのやりとりの失敗（画面に出せる文）。 */
export class CanvaError extends Error {}

/** 書き出したファイルを取ってよい置き場（Canva の書き出しの置き場だけ）。 */
export function isCanvaDownloadUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' && /(^|\.)canva\.com$/i.test(u.hostname) && !u.username && !u.password && !u.port;
}

/** 本物の Canva の API。 */
export class HttpCanvaApi implements CanvaApi {
  constructor(private readonly o: {
    clientId: string; clientSecret: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>;
    endpoints?: typeof CANVA_ENDPOINTS; pollMs?: number; pollTimes?: number;
  }) {}

  private get fetch() { return this.o.fetchImpl ?? fetch; }
  private get ep() { return this.o.endpoints ?? CANVA_ENDPOINTS; }
  private wait(ms: number) { return this.o.sleep ? this.o.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms)); }

  authorizeUrl(p: { redirectUri: string; state: string; codeChallenge: string }): string {
    const q = new URLSearchParams({
      code_challenge: p.codeChallenge, code_challenge_method: 's256', response_type: 'code', client_id: this.o.clientId,
      scope: CANVA_SCOPES.join(' '), state: p.state, redirect_uri: p.redirectUri,
    });
    return `${this.ep.authorize}?${q}`;
  }

  private async token(form: Record<string, string>): Promise<CanvaTokens> {
    const res = await this.fetch(this.ep.token, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${this.o.clientId}:${this.o.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof j['access_token'] !== 'string' || typeof j['refresh_token'] !== 'string') {
      throw new CanvaError(`Canva の許可を確かめられませんでした（${String(j['error'] ?? res.status)}）`);
    }
    return { accessToken: j['access_token'], refreshToken: j['refresh_token'], expiresIn: Number(j['expires_in'] ?? 14_400) };
  }

  exchange(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<CanvaTokens> {
    return this.token({ grant_type: 'authorization_code', code: p.code, code_verifier: p.codeVerifier, redirect_uri: p.redirectUri });
  }

  refresh(refreshToken: string): Promise<CanvaTokens> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.fetch(this.ep.revoke, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.o.clientId, client_secret: this.o.clientSecret, token: refreshToken }).toString(),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => undefined);
  }

  /** API を呼ぶ（JSON）。 */
  private async call(accessToken: string, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const res = await this.fetch(`${this.ep.api}${path}`, {
      ...init, headers: { authorization: `Bearer ${accessToken}`, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(60_000),
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new CanvaError(`Canva でできませんでした（${String((j['message'] as string | undefined) ?? res.status)}）`);
    return j;
  }

  /** 終わるまで待つ（1 秒ごと。既定は 90 回まで）。 */
  private async poll(accessToken: string, path: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < (this.o.pollTimes ?? 90); i += 1) {
      const job = (await this.call(accessToken, path))['job'] as Record<string, unknown> | undefined;
      if (job?.['status'] === 'success') return job;
      if (job?.['status'] === 'failed') {
        const e = job['error'] as { message?: string } | undefined;
        throw new CanvaError(`Canva でできませんでした（${e?.message ?? '理由は分かりません'}）`);
      }
      await this.wait(this.o.pollMs ?? 1000);
    }
    throw new CanvaError('Canva の処理が時間内に終わりませんでした。しばらくしてからもう一度お試しください');
  }

  async importPdf(accessToken: string, title: string, pdf: Uint8Array): Promise<{ designId: string; editUrl: string }> {
    const meta = JSON.stringify({ title_base64: Buffer.from(title.slice(0, 50), 'utf8').toString('base64'), mime_type: 'application/pdf' });
    const started = await this.call(accessToken, '/imports', {
      method: 'POST', headers: { 'content-type': 'application/octet-stream', 'import-metadata': meta }, body: pdf as unknown as BodyInit,
    });
    const id = String((started['job'] as Record<string, unknown> | undefined)?.['id'] ?? '');
    if (!id) throw new CanvaError('Canva に取り込めませんでした');
    const job = await this.poll(accessToken, `/imports/${encodeURIComponent(id)}`);
    const d = ((job['result'] as Record<string, unknown> | undefined)?.['designs'] as Record<string, unknown>[] | undefined)?.[0];
    const editUrl = String((d?.['urls'] as Record<string, unknown> | undefined)?.['edit_url'] ?? '');
    if (!d?.['id'] || !/^https:\/\//.test(editUrl)) throw new CanvaError('Canva に取り込めませんでした');
    return { designId: String(d['id']), editUrl };
  }

  async exportDesign(accessToken: string, designId: string, type: 'pdf' | 'png'): Promise<Uint8Array[]> {
    const started = await this.call(accessToken, '/exports', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ design_id: designId, format: { type } }),
    });
    const id = String((started['job'] as Record<string, unknown> | undefined)?.['id'] ?? '');
    if (!id) throw new CanvaError('Canva から書き出せませんでした');
    const job = await this.poll(accessToken, `/exports/${encodeURIComponent(id)}`);
    const urls = (job['urls'] as unknown[] | undefined)?.map(String) ?? [];
    if (!urls.length) throw new CanvaError('Canva から書き出せませんでした');
    const out: Uint8Array[] = [];
    for (const url of urls.slice(0, 10)) {
      // 書き出しの置き場の外へは取りに行かない。転送も追わない
      if (!isCanvaDownloadUrl(url)) throw new CanvaError('Canva の書き出しの置き場ではない場所が返されました');
      const res = await this.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new CanvaError('Canva から書き出したファイルを受け取れませんでした');
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > 50 * 1024 * 1024) throw new CanvaError('Canva から書き出したファイルが大きすぎます');
      out.push(buf);
    }
    return out;
  }
}

/**
 * 見本の Canva（開発と自動テスト。`CANVA_MOCK=true`）。外には何も送らない。
 * 許可の画面は開かず、M2Office の戻り先へそのまま戻す。書き出すと、取り込んだ PDF と、見本の PNG を返す。
 */
export class MockCanvaApi implements CanvaApi {
  readonly designs = new Map<string, { title: string; pdf: Uint8Array }>();
  readonly revoked: string[] = [];
  private seq = 0;

  authorizeUrl(p: { redirectUri: string; state: string; codeChallenge: string }): string {
    return `${p.redirectUri}?${new URLSearchParams({ code: `mock-code-${p.codeChallenge.slice(0, 8)}`, state: p.state })}`;
  }

  async exchange(p: { code: string }): Promise<CanvaTokens> {
    if (!p.code.startsWith('mock-code-')) throw new CanvaError('Canva の許可を確かめられませんでした（invalid_grant）');
    return { accessToken: `mock-access-${++this.seq}`, refreshToken: `mock-refresh-${this.seq}`, expiresIn: 14_400 };
  }

  async refresh(refreshToken: string): Promise<CanvaTokens> {
    if (!refreshToken.startsWith('mock-refresh-') || this.revoked.includes(refreshToken)) throw new CanvaError('Canva の許可を確かめられませんでした（invalid_grant）');
    // 1 回使ったリフレッシュ トークンは使えなくなる（本物と同じ）
    this.revoked.push(refreshToken);
    return { accessToken: `mock-access-${++this.seq}`, refreshToken: `mock-refresh-${this.seq}`, expiresIn: 14_400 };
  }

  async revoke(refreshToken: string): Promise<void> {
    this.revoked.push(refreshToken);
  }

  async importPdf(_accessToken: string, title: string, pdf: Uint8Array): Promise<{ designId: string; editUrl: string }> {
    const designId = `mock-design-${++this.seq}`;
    this.designs.set(designId, { title, pdf });
    return { designId, editUrl: `https://www.canva.com/design/${designId}/edit` };
  }

  async exportDesign(_accessToken: string, designId: string, type: 'pdf' | 'png'): Promise<Uint8Array[]> {
    const d = this.designs.get(designId);
    if (!d) throw new CanvaError('Canva のデザインが見つかりません');
    if (type === 'pdf') return [d.pdf];
    return [renderSvgPng('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 210 297"><rect width="210" height="297" fill="#f4efe6"/><text x="105" y="150" font-size="18" text-anchor="middle" fill="#333">Canva</text></svg>', 1240)];
  }
}

/** 本人の Canva の接続の置き場。 */
export interface CanvaConnectionStore {
  get(tenantId: string, userId: string): Promise<{ refreshTokenEnc: string; connectedAt: string } | null>;
  save(tenantId: string, userId: string, refreshTokenEnc: string): Promise<void>;
  delete(tenantId: string, userId: string): Promise<void>;
}

/** PostgreSQL の置き場（行単位の制限つき）。 */
export class PostgresCanvaConnectionStore implements CanvaConnectionStore {
  private readonly pool: pg.Pool;
  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 2 });
  }

  private async q<T extends pg.QueryResultRow>(tenantId: string, text: string, params: unknown[]): Promise<T[]> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      const r = await c.query<T>(text, params);
      await c.query('commit');
      return r.rows;
    } catch (err) {
      await c.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  async get(tenantId: string, userId: string) {
    const rows = await this.q<{ refresh_token_enc: string; connected_at: Date }>(tenantId,
      `select refresh_token_enc, connected_at from canva_connections where tenant_id = $1 and user_id = $2`, [tenantId, userId]);
    return rows[0] ? { refreshTokenEnc: rows[0].refresh_token_enc, connectedAt: new Date(rows[0].connected_at).toISOString() } : null;
  }

  async save(tenantId: string, userId: string, refreshTokenEnc: string): Promise<void> {
    await this.q(tenantId,
      `insert into canva_connections (tenant_id, user_id, refresh_token_enc) values ($1, $2, $3)
       on conflict (tenant_id, user_id) do update set refresh_token_enc = excluded.refresh_token_enc, updated_at = now()`, [tenantId, userId, refreshTokenEnc]);
  }

  async delete(tenantId: string, userId: string): Promise<void> {
    await this.q(tenantId, `delete from canva_connections where tenant_id = $1 and user_id = $2`, [tenantId, userId]);
  }
}

/** テスト用のメモリの置き場。 */
export class MemoryCanvaConnectionStore implements CanvaConnectionStore {
  readonly rows = new Map<string, { refreshTokenEnc: string; connectedAt: string }>();
  async get(tenantId: string, userId: string) { return this.rows.get(`${tenantId}:${userId}`) ?? null; }
  async save(tenantId: string, userId: string, refreshTokenEnc: string) {
    const k = `${tenantId}:${userId}`;
    this.rows.set(k, { refreshTokenEnc, connectedAt: this.rows.get(k)?.connectedAt ?? new Date().toISOString() });
  }
  async delete(tenantId: string, userId: string) { this.rows.delete(`${tenantId}:${userId}`); }
}

/** 本人。 */
export interface CanvaViewer {
  tenantId: string;
  userId: string;
}

/**
 * 本人の Canva の接続と、取り込み・書き出し（販促物の作成から使う。`PrintCanva`）。
 *
 * @remarks リフレッシュ トークンは 1 回しか使えないため、本人ごとに取り直しを 1 つずつ行う
 */
export class CanvaService {
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(readonly deps: { api: CanvaApi; store: CanvaConnectionStore; box: SecretBox; redirectUri: string; now?: () => number }) {}

  private now() { return this.deps.now ? this.deps.now() : Date.now(); }

  /** 本人がつないでいるか。 */
  async status(who: CanvaViewer): Promise<{ connected: boolean; connectedAt: string | null }> {
    const c = await this.deps.store.get(who.tenantId, who.userId);
    return { connected: !!c, connectedAt: c?.connectedAt ?? null };
  }

  /** 許可を求める画面の URL（`state` と PKCE は呼ぶ側が用意する）。 */
  authorizeUrl(state: string, codeChallenge: string): string {
    return this.deps.api.authorizeUrl({ redirectUri: this.deps.redirectUri, state, codeChallenge });
  }

  /** 戻ってきたコードでつなぐ。 */
  async finishConnect(who: CanvaViewer, code: string, codeVerifier: string): Promise<void> {
    const t = await this.deps.api.exchange({ code, codeVerifier, redirectUri: this.deps.redirectUri });
    await this.deps.store.save(who.tenantId, who.userId, this.deps.box.encrypt(t.refreshToken));
    this.cache.set(`${who.tenantId}:${who.userId}`, { token: t.accessToken, expiresAt: this.now() + t.expiresIn * 1000 });
  }

  /** 切断する（Canva の許可も取り消し、トークンを消す）。 */
  async disconnect(who: CanvaViewer): Promise<boolean> {
    const c = await this.deps.store.get(who.tenantId, who.userId);
    if (!c) return false;
    await this.deps.api.revoke(this.deps.box.decrypt(c.refreshTokenEnc)).catch(() => undefined);
    await this.deps.store.delete(who.tenantId, who.userId);
    this.cache.delete(`${who.tenantId}:${who.userId}`);
    return true;
  }

  /** 本人のアクセス トークン（切れていれば取り直し、新しいリフレッシュ トークンを持つ）。 */
  private async accessToken(who: CanvaViewer): Promise<string> {
    const key = `${who.tenantId}:${who.userId}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt - 60_000 > this.now()) return hit.token;
    // 本人ごとに 1 つずつ（同じリフレッシュ トークンを 2 回使わない）
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(async () => {
      const again = this.cache.get(key);
      if (again && again.expiresAt - 60_000 > this.now()) return again.token;
      const c = await this.deps.store.get(who.tenantId, who.userId);
      if (!c) throw new CanvaError('Canva とつないでいません。個人設定の「サービスとの接続」でつないでください');
      let t: CanvaTokens;
      try {
        t = await this.deps.api.refresh(this.deps.box.decrypt(c.refreshTokenEnc));
      } catch (err) {
        // 取り消された・切れた許可は消し、つなぎ直してもらう
        if (err instanceof CanvaError && /invalid_grant/.test(err.message)) await this.deps.store.delete(who.tenantId, who.userId);
        throw new CanvaError('Canva の許可が切れています。個人設定の「サービスとの接続」でつなぎ直してください');
      }
      await this.deps.store.save(who.tenantId, who.userId, this.deps.box.encrypt(t.refreshToken));
      this.cache.set(key, { token: t.accessToken, expiresAt: this.now() + t.expiresIn * 1000 });
      return t.accessToken;
    });
    this.locks.set(key, run);
    return run as Promise<string>;
  }

  /** PDF を本人の Canva に取り込む。 */
  async importPdf(who: CanvaViewer, title: string, pdf: Uint8Array): Promise<{ designId: string; editUrl: string } | { error: string }> {
    try {
      return await this.deps.api.importPdf(await this.accessToken(who), title, pdf);
    } catch (err) {
      return { error: err instanceof CanvaError ? err.message : 'Canva に取り込めませんでした' };
    }
  }

  /** 本人の Canva のデザインを PDF と PNG（1 面目）で書き出す。 */
  async exportDesign(who: CanvaViewer, designId: string): Promise<{ pdf: Uint8Array; png: Uint8Array } | { error: string }> {
    try {
      const token = await this.accessToken(who);
      const [pdf] = await this.deps.api.exportDesign(token, designId, 'pdf');
      const [png] = await this.deps.api.exportDesign(token, designId, 'png');
      if (!pdf || !png) return { error: 'Canva から書き出せませんでした' };
      return { pdf, png };
    } catch (err) {
      return { error: err instanceof CanvaError ? err.message : 'Canva から書き出せませんでした' };
    }
  }
}
