/**
 * @file 店頭サイネージの処理（仕様書 第31章の段 1）。画面の登録・素材・流れ・再生のページへの答え・生きている知らせ・つながらない知らせ。
 *
 * 画面は 1 社 3 台まで。画面の鍵は SHA-256 のハッシュだけを持つ（第31.5.1節）。素材の形式はサーバーでも確かめ直し、作り直さない（第31.6.1節）。
 * 会社が登録した画面に出すことは社外への送信に当たらない（ADR-0051）。
 */

import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import {
  canUseAgent, SIGNAGE_EXTENSION_ID, SIGNAGE_JINGLES, SIGNAGE_LIMITS, SIGNAGE_MAX_SCREENS, SIGNAGE_STORAGE_LIMIT, SIGNAGE_DEFAULT_COLOR,
  type AuditEvent, type SignageAsset, type SignageEntry, type SignageOrientation, type SignageReport, type SignageRotation,
  type SignageScreen, type SignageSettings,
} from '@m2office/shared';
import type { Repository } from '../repository/types.js';
import { fileReader, type FileStore } from '../files/store.js';
import type { ScreenRecord, SignageStore } from './store.js';
import { thumbnailMime, thumbnailPng } from './thumbnail.js';
import { readMp4 } from './mp4.js';
import { imageSize } from './image-size.js';

/** 処理に要るもの。 */
export interface SignageServiceDeps {
  store: SignageStore;
  repo: Repository;
  files: FileStore;
  now?: () => Date;
}

/** 画面の鍵・登録の合言葉のハッシュ。 */
export const hashSecret = (s: string) => createHash('sha256').update(s).digest('hex');
/** 画面の鍵（24 バイトの乱数を base64url にした 32 字。第31.5.1節）。 */
const newKey = () => randomBytes(24).toString('base64url');
/** 画面の鍵・登録の合言葉の形。 */
export const SECRET_FORMAT = /^[A-Za-z0-9_-]{32,64}$/;
/** 素材の中身の置き場の名前。 */
export const assetKey = (id: string) => `signage-${id}`;

/** つながっているとみなす、最後の知らせからの時間（第31.5.1節）。 */
const ONLINE_MS = 3 * 60_000;
/** つながらない知らせを出すまでの時間。 */
const OFFLINE_NOTIFY_MS = 5 * 60_000;
const JST_MS = 9 * 3_600_000;

/** 日本時間の日と、30 分ごとの時間帯（0〜47）。 */
export function jstSlot(d: Date): { day: string; slot: number } {
  const t = new Date(d.getTime() + JST_MS);
  return { day: t.toISOString().slice(0, 10), slot: t.getUTCHours() * 2 + (t.getUTCMinutes() >= 30 ? 1 : 0) };
}

/**
 * ふだん動いている時間帯か（第31.5.1節）。過去 14 日の記録のうち、その時間帯に知らせがあった日が半分以上なら動いている。
 * 記録が 3 日に満たない間は、日本時間の 7 時から 22 時を動いている時間帯とする（決まった計算。推論を使わない）。
 *
 * @param days 過去の日ごとの時間帯の印（今日を除く）
 */
export function usualSlot(days: { slots: bigint }[], slot: number): boolean {
  if (days.length < 3) return slot >= 14 && slot < 44;
  const hit = days.filter((d) => (d.slots >> BigInt(slot)) & 1n).length;
  return hit * 2 >= days.length;
}

/** 生きている知らせの中身を整える（画面の値を信じない。割り込みの文は受けない）。 */
export function cleanReport(v: unknown): SignageReport | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const ids = (x: unknown) => (Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(i)).slice(0, 100) : []);
  const num = (x: unknown, max: number) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.min(Math.round(x), max) : 0);
  const vp = (o['viewport'] ?? {}) as Record<string, unknown>;
  return {
    current: typeof o['current'] === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(o['current']) ? o['current'] : null,
    flowVersion: num(o['flowVersion'], 1e9),
    cached: num(o['cached'], 10_000),
    uncached: ids(o['uncached']),
    failed: ids(o['failed']),
    pageVersion: typeof o['pageVersion'] === 'string' ? o['pageVersion'].slice(0, 32) : '',
    viewport: { width: num(vp['width'], 10_000), height: num(vp['height'], 10_000) },
    storageFree: typeof o['storageFree'] === 'number' && Number.isFinite(o['storageFree']) ? Math.max(0, Math.round(o['storageFree'])) : null,
    audio: typeof o['audio'] === 'boolean' ? o['audio'] : null,
    interrupting: o['interrupting'] === true,
  };
}

/** 送られた素材（API が一時ファイルに書いたもの）。 */
export interface AssetUpload {
  path: string;
  bytes: number;
  sha256: string;
  mime: string;
  name: string;
  thumbnail: Uint8Array | null;
  /** 画面で調べた値（動画の縦横。サーバーでも確かめる）。 */
  width?: number;
  height?: number;
  /** 動画の下に重ねて出す字幕（コラムから作った動画。第32.18.6節）。動画のときだけ使う。 */
  caption?: string | null;
}

/** 再生のページに渡す素材（中身の場所は ID で引く）。 */
export type PlayAsset = Pick<SignageAsset, 'id' | 'kind' | 'mime' | 'sha256' | 'bytes' | 'width' | 'height' | 'durationMs' | 'caption'>;

/**
 * 店頭サイネージの処理。
 *
 * @remarks テナント境界: 置き場が会社ごとに絞る（不変則 I-2）。使えるか（入り切りと利用範囲）の確かめは呼ぶ側（API）が {@link signageAccess} で行う
 */
export class SignageService {
  /** 画面ごとの変化の知らせ（`${tenantId}:${screenId}`、`${tenantId}:*` は会社の全画面）。再生のページの即時の知らせが聞く。 */
  readonly changes = new EventEmitter();
  /** 番号の入れ間違い（人ごと。第31.5.1節）。 */
  private readonly misses = new Map<string, number[]>();
  /** 流れの直しの監査ログをまとめる（人と画面ごとの最後の時刻。第31.6.2節）。 */
  private readonly flowAudits = new Map<string, number>();

  constructor(readonly deps: SignageServiceDeps) {
    this.changes.setMaxListeners(0);
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** 会社の設定。 */
  async settings(tenantId: string): Promise<SignageSettings> {
    return (await this.deps.repo.getTenantSettings(tenantId)).signage;
  }

  private emit(tenantId: string, screenId: string | '*', kind: 'flow' | 'screen' | 'removed' | 'settings' | 'volume') {
    this.changes.emit(`${tenantId}:${screenId}`, kind);
  }

  /** 設定が変わったことを画面に知らせる（管理者の設定の変更から呼ぶ）。 */
  settingsChanged(tenantId: string): void {
    this.emit(tenantId, '*', 'settings');
  }

  private view(s: ScreenRecord): SignageScreen {
    const now = this.now().getTime();
    return {
      id: s.id, name: s.name, orientation: s.orientation, rotation: s.rotation, volume: s.volume, flowVersion: s.flowVersion,
      lastSeenAt: s.lastSeenAt, lastReport: s.lastReport, online: !!s.lastSeenAt && now - Date.parse(s.lastSeenAt) <= ONLINE_MS, registeredAt: s.registeredAt,
    };
  }

  private async audit(tenantId: string, userId: string, action: string, targetId: string, detail: Record<string, unknown>): Promise<void> {
    const ev: AuditEvent = { id: randomUUID(), tenantId, actorType: 'user', actorId: userId, action, targetType: 'signage', targetId, detail, occurredAt: this.now().toISOString() };
    await this.deps.repo.appendAudit(ev);
  }

  /** 管理の画面の中身（画面の一覧と状態・使っている容量と上限）。 */
  async overview(tenantId: string): Promise<{ screens: SignageScreen[]; usage: { bytes: number; limit: number }; maxScreens: number; settings: SignageSettings }> {
    const [screens, bytes, settings] = await Promise.all([this.deps.store.listScreens(tenantId), this.deps.store.totalBytes(tenantId), this.settings(tenantId)]);
    return { screens: screens.map((s) => this.view(s)), usage: { bytes, limit: SIGNAGE_STORAGE_LIMIT }, maxScreens: SIGNAGE_MAX_SCREENS, settings };
  }

  /**
   * 画面の名前・向き・回し方を直す（利用範囲の全員）。
   *
   * @remarks 危険度: 低（社内の画面の設定を変える）
   */
  async updateScreen(tenantId: string, userId: string, id: string, input: { name?: unknown; orientation?: unknown; rotation?: unknown; volume?: unknown }): Promise<{ screen: SignageScreen } | { error: string }> {
    const patch: { name?: string; orientation?: SignageOrientation; rotation?: SignageRotation; volume?: number } = {};
    if (input.volume !== undefined) {
      const v = Number(input.volume);
      if (!Number.isInteger(v) || v < 0 || v > 100) return { error: '音の大きさは 0〜100 にしてください' };
      patch.volume = v;
    }
    if (input.name !== undefined) {
      const name = String(input.name ?? '').trim();
      if (!name || [...name].length > 20) return { error: '画面の名前は 1〜20 字にしてください' };
      patch.name = name;
    }
    if (input.orientation !== undefined) {
      if (input.orientation !== 'landscape' && input.orientation !== 'portrait') return { error: '向きが違います' };
      patch.orientation = input.orientation;
    }
    if (input.rotation !== undefined) {
      if (![0, 90, 180, 270].includes(input.rotation as number)) return { error: '回し方は 0・90・180・270 度です' };
      patch.rotation = input.rotation as SignageRotation;
    }
    let s: ScreenRecord | null;
    try {
      s = await this.deps.store.updateScreen(tenantId, id, patch, userId);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return { error: '同じ名前の画面があります' };
      throw err;
    }
    if (!s) return { error: '画面が見つかりません' };
    await this.audit(tenantId, userId, 'signage.screen.update', id, { fields: Object.keys(patch) });
    // 音の大きさを変えたら、その画面でジングルを 1 回鳴らす（試す専用のボタンを置かない。第31.9.2節）
    this.emit(tenantId, id, patch.volume !== undefined ? 'volume' : 'screen');
    return { screen: this.view(s) };
  }

  /**
   * 登録の番号を作る（再生のページから。第31.5.1節）。
   *
   * @param secret 端末が作った登録の合言葉（ハッシュだけを持つ）
   */
  async createPairing(tenantId: string, secret: unknown, viewport: unknown): Promise<{ code: string; expiresAt: string } | { error: string }> {
    if (typeof secret !== 'string' || !SECRET_FORMAT.test(secret)) return { error: '登録の合言葉が違います' };
    const vp = (viewport ?? {}) as { width?: unknown; height?: unknown };
    const width = Number(vp.width);
    const height = Number(vp.height);
    if (!(width > 0 && height > 0 && width < 20_000 && height < 20_000)) return { error: '画面の縦横が違います' };
    const now = this.now();
    // 登録を待つ番号は会社ごとに 5 つまで。超えたら古い番号から消す
    await this.deps.store.trimPairings(tenantId, 4);
    let code = '';
    for (let i = 0; i < 20 && !code; i++) {
      const c = String(randomInt(0, 1_000_000)).padStart(6, '0');
      if (!(await this.deps.store.findPairingByCode(tenantId, c, now))) code = c;
    }
    if (!code) return { error: '番号を作れませんでした。もう一度お試しください' };
    const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    await this.deps.store.createPairing(tenantId, { id: randomUUID(), code, secretHash: hashSecret(secret), viewport: { width: Math.round(width), height: Math.round(height) }, expiresAt });
    return { code, expiresAt };
  }

  /**
   * 登録されたかを尋ねる（再生のページから）。登録されていれば、このときに画面の鍵を作り、1 度だけ返す（第31.5.1節）。
   */
  async pollPairing(tenantId: string, secret: unknown): Promise<{ status: 'waiting' | 'expired' } | { status: 'registered'; key: string; screenId: string }> {
    if (typeof secret !== 'string' || !SECRET_FORMAT.test(secret)) return { status: 'expired' };
    const p = await this.deps.store.findPairingBySecret(tenantId, hashSecret(secret));
    if (!p) return { status: 'expired' };
    if (p.screenId) {
      const key = newKey();
      await this.deps.store.setScreenKey(tenantId, p.screenId, hashSecret(key));
      await this.deps.store.deletePairing(tenantId, p.id);
      return { status: 'registered', key, screenId: p.screenId };
    }
    if (Date.parse(p.expiresAt) < this.now().getTime()) return { status: 'expired' };
    return { status: 'waiting' };
  }

  /**
   * 番号で画面を登録する（管理者だけ。第31.5.1節）。名前と向きは尋ねずに決める。外して 30 日以内の画面があれば、それとして登録し直す。
   *
   * @remarks 危険度: 低（会社の画面を増やす。画面に出すことは社外への送信に当たらない。ADR-0051）
   */
  async claim(tenantId: string, userId: string, code: unknown): Promise<{ screen: SignageScreen; restored: boolean } | { error: string; screens?: string[]; status: number }> {
    const now = this.now();
    const tries = (this.misses.get(`${tenantId}:${userId}`) ?? []).filter((t) => now.getTime() - t < 10 * 60_000);
    if (tries.length >= 5) return { error: '番号を何度も間違えたため、10 分ほど入れられません', status: 429 };
    const c = String(code ?? '').normalize('NFKC').replace(/\s/g, '');
    const p = /^\d{6}$/.test(c) ? await this.deps.store.findPairingByCode(tenantId, c, now) : null;
    if (!p) {
      this.misses.set(`${tenantId}:${userId}`, [...tries, now.getTime()]);
      return { error: '番号が見つからないか、切れています。画面に出ている番号を確かめてください', status: 404 };
    }
    const active = await this.deps.store.listScreens(tenantId);
    if (active.length >= SIGNAGE_MAX_SCREENS) return { error: `画面は ${SIGNAGE_MAX_SCREENS} 台までです。使っていない画面を切断してから登録してください`, screens: active.map((s) => s.name), status: 409 };
    const orientation: SignageOrientation = p.viewport.height > p.viewport.width ? 'portrait' : 'landscape';
    const all = await this.deps.store.listScreens(tenantId, true);
    const recent = all.filter((s) => s.status === 'removed' && s.removedAt && now.getTime() - Date.parse(s.removedAt) <= 30 * 86_400_000)
      .sort((a, b) => Date.parse(b.removedAt!) - Date.parse(a.removedAt!))[0];
    let id: string;
    let restored = false;
    if (recent) {
      id = recent.id;
      await this.deps.store.restoreScreen(tenantId, id, orientation, userId);
      // 同じ名前の画面が使われていれば、名前を付け直す
      if (active.some((s) => s.name === recent.name)) await this.deps.store.updateScreen(tenantId, id, { name: freeName(active.map((s) => s.name)) }, userId);
      restored = true;
    } else {
      id = randomUUID();
      await this.deps.store.createScreen(tenantId, { id, name: freeName(all.filter((s) => s.status === 'active').map((s) => s.name)), orientation }, userId);
    }
    await this.deps.store.setPairingScreen(tenantId, p.id, id);
    const s = (await this.deps.store.getScreen(tenantId, id))!;
    await this.audit(tenantId, userId, 'signage.screen.register', id, { name: s.name, orientation, restored });
    return { screen: this.view(s), restored };
  }

  /**
   * 画面を外す（管理者だけ。確認を挟まない。第31.5.1節）。鍵はその場で効かなくなる。
   *
   * @remarks 危険度: 低（会社の画面を止める。30 日以内なら同じ端末で登録し直せば戻る）
   */
  async removeScreen(tenantId: string, userId: string, id: string): Promise<boolean> {
    const s = await this.deps.store.removeScreen(tenantId, id, userId);
    if (!s) return false;
    await this.audit(tenantId, userId, 'signage.screen.remove', id, { name: s.name, orientation: s.orientation });
    this.emit(tenantId, id, 'removed');
    return true;
  }

  /** 素材の一覧（どの画面の流れに入っているかつき）。 */
  async listAssets(tenantId: string): Promise<(SignageAsset & { screens: string[] })[]> {
    const [assets, screens] = await Promise.all([this.deps.store.listAssets(tenantId), this.deps.store.listScreens(tenantId)]);
    const uses = new Map<string, string[]>();
    for (const s of screens) for (const e of await this.deps.store.listEntries(tenantId, s.id)) {
      const list = uses.get(e.assetId) ?? [];
      if (!list.includes(s.id)) list.push(s.id);
      uses.set(e.assetId, list);
    }
    return assets.map((a) => ({ ...a, screens: uses.get(a.id) ?? [] }));
  }

  /**
   * 素材を足す（第31.6.1節）。形式・大きさ・縦横・長さをサーバーでも確かめ直す。同じ中身は前の素材を返す。
   *
   * @remarks 危険度: 低（会社の素材の置き場に足す）。一時ファイルは、受け取っても断っても無くなる
   */
  async addAsset(tenantId: string, userId: string, up: AssetUpload): Promise<{ asset: SignageAsset; existing: boolean } | { error: string; status: number }> {
    const drop = async <T>(r: T): Promise<T> => { await rm(up.path, { force: true }); return r; };
    const thumb = up.thumbnail && up.thumbnail.length > 0 ? up.thumbnail : null;
    // 縮小画像は、画面が作る JPEG か、サーバーが作る PNG（第 0.259.1 版）
    if (thumb && (thumb.length > SIGNAGE_LIMITS.thumbnailBytes || !thumbnailMime(thumb))) return drop({ error: '縮小画像が違います', status: 400 });
    let kind: SignageAsset['kind'];
    let mime: SignageAsset['mime'];
    let width = 0;
    let height = 0;
    let durationMs: number | null = null;
    const reader = await fileReader(up.path);
    try {
      const head = await reader.read(0, 64 * 1024);
      const img = imageSize(head);
      if (!img && isHtml(up.mime, head)) {
        // 会社が作った HTML（第31.6.3節）。外への参照が残っていれば受け取らない
        if (up.bytes > SIGNAGE_LIMITS.htmlBytes) return drop({ error: 'HTML が大きすぎます（中に入れた後で 10 MB まで）', status: 413 });
        let html: string;
        try { html = new TextDecoder('utf-8', { fatal: true }).decode(await reader.read(0, up.bytes)); } catch { return drop({ error: 'HTML は UTF-8 の文字にしてください', status: 422 }); }
        const refs = externalRefs(html);
        if (refs.length) return drop({ error: `外への参照があります（${refs.slice(0, 5).join('・')}）。画像などは HTML の中に入れてください`, status: 422 });
        kind = 'html';
        mime = 'text/html';
        width = Number(up.width) || 1920;
        height = Number(up.height) || 1080;
        const title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(html)?.[1]?.trim();
        if (title && !up.name.trim()) up.name = title;
      } else if (img) {
        kind = 'image';
        mime = img.mime;
        width = img.width;
        height = img.height;
        if (up.bytes > SIGNAGE_LIMITS.imageBytes) return drop({ error: '画像が大きすぎます（縮めた後で 5 MB まで）', status: 413 });
        if (Math.max(width, height) > 1920) return drop({ error: '画像の長い辺が 1,920 を超えています', status: 422 });
      } else {
        const info = await readMp4(reader.read, reader.size);
        if (!info.ok) return drop({ error: info.reason.includes('MP4 の動画ではありません') ? '画像（JPEG・PNG）・動画（MP4）・HTML を選んでください' : info.reason, status: 422 });
        kind = 'video';
        mime = 'video/mp4';
        width = info.width || Number(up.width) || 0;
        height = info.height || Number(up.height) || 0;
        durationMs = info.durationMs;
        if (up.bytes > SIGNAGE_LIMITS.videoBytes) return drop({ error: '動画が大きすぎます（200 MB まで）', status: 413 });
        if (durationMs < 1000 || durationMs > SIGNAGE_LIMITS.videoMs) return drop({ error: '動画は 1 秒から 10 分までにしてください', status: 422 });
        if (Math.max(width, height) > 1920 || Math.min(width, height) > 1080) return drop({ error: '動画はフル HD（1920×1080）までにしてください', status: 422 });
        if (!width || !height) return drop({ error: '動画の縦横を読めませんでした', status: 422 });
      }
    } finally {
      await reader.close();
    }
    const same = await this.deps.store.findAssetBySha(tenantId, up.sha256);
    if (same) return drop({ asset: same, existing: true });
    const used = await this.deps.store.totalBytes(tenantId);
    if (used + up.bytes > SIGNAGE_STORAGE_LIMIT) return drop({ error: `素材の置き場がいっぱいです（${fmtBytes(used)} / ${fmtBytes(SIGNAGE_STORAGE_LIMIT)}）。使っていない素材を消してください`, status: 413 });
    const name = up.name.trim().slice(0, 60) || '素材';
    const id = randomUUID();
    const files = this.deps.files;
    if (files.putFile) await files.putFile(tenantId, assetKey(id), up.path);
    else {
      const r = await fileReader(up.path);
      try { await files.put(tenantId, assetKey(id), await r.read(0, r.size)); } finally { await r.close(); }
      await rm(up.path, { force: true });
    }
    // 字幕は動画だけ（2 行・80 字まで）
    const caption = kind === 'video' && up.caption ? up.caption.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join('\n').slice(0, 80) || null : null;
    await this.deps.store.insertAsset(tenantId, { id, kind, name, mime, bytes: up.bytes, sha256: up.sha256, width, height, durationMs, thumbnail: thumb, caption }, userId);
    await this.audit(tenantId, userId, 'signage.asset.add', id, { name, kind, bytes: up.bytes, sha256: up.sha256 });
    return { asset: (await this.deps.store.getAsset(tenantId, id))!, existing: false };
  }

  /** 縮小画像を入れる（JPEG か PNG・100 KB まで。画面で作って送る。第31.6.1節）。 */
  async setThumbnail(tenantId: string, id: string, bytes: Uint8Array): Promise<{ ok: true } | { error: string }> {
    if (bytes.length === 0 || bytes.length > SIGNAGE_LIMITS.thumbnailBytes || !thumbnailMime(bytes)) return { error: '縮小画像は 100 KB までの JPEG か PNG にしてください' };
    return (await this.deps.store.setThumbnail(tenantId, id, bytes)) ? { ok: true } : { error: '素材が見つかりません' };
  }

  /**
   * 素材の縮小画像。無い画像の素材は、その場で作って残す（サーバーが足した素材・前に足した素材。第 0.259.1 版）。
   *
   * @returns 中身と種類。作れなければ `null`
   */
  async thumbnail(tenantId: string, id: string): Promise<{ bytes: Uint8Array; mime: 'image/jpeg' | 'image/png' } | null> {
    const t = await this.deps.store.getThumbnail(tenantId, id);
    if (t) return { bytes: t, mime: thumbnailMime(t) ?? 'image/jpeg' };
    const a = await this.deps.store.getAsset(tenantId, id);
    if (!a || a.kind !== 'image') return null;
    const bytes = await this.deps.files.get(tenantId, assetKey(id));
    const png = bytes ? thumbnailPng(bytes) : null;
    if (!png) return null;
    await this.deps.store.setThumbnail(tenantId, id, png);
    return { bytes: png, mime: 'image/png' };
  }

  /**
   * 割り込みの素材にする・外す、その音を変える（画像か HTML だけ。会社で 50 まで。第31.7.3節）。
   *
   * @remarks 危険度: 低（会社の画面に出せる素材を選ぶ）
   */
  async setInterruptAsset(tenantId: string, userId: string, id: string, input: { isInterrupt?: unknown; jingle?: unknown }): Promise<{ asset: SignageAsset } | { error: string }> {
    const a = await this.deps.store.getAsset(tenantId, id);
    if (!a) return { error: '素材が見つかりません' };
    const patch: { isInterrupt?: boolean; jingle?: string | null } = {};
    if (input.isInterrupt !== undefined) {
      if (typeof input.isInterrupt !== 'boolean') return { error: '割り込みの素材にするかは真偽で送ってください' };
      if (input.isInterrupt && a.kind === 'video') return { error: '動画は割り込みの素材にできません' };
      if (input.isInterrupt && !a.isInterrupt && (await this.deps.store.listAssets(tenantId)).filter((x) => x.isInterrupt).length >= SIGNAGE_LIMITS.interruptAssets) {
        return { error: `割り込みの素材は ${SIGNAGE_LIMITS.interruptAssets} までです` };
      }
      patch.isInterrupt = input.isInterrupt;
    }
    if (input.jingle !== undefined) {
      const j = input.jingle === null || input.jingle === '' ? null : String(input.jingle);
      if (j && !SIGNAGE_JINGLES.some((x) => x.id === j) && !(await this.deps.store.listSounds(tenantId)).some((s) => s.id === j)) return { error: '知らない音です' };
      patch.jingle = j;
    }
    const next = await this.deps.store.setAssetInterrupt(tenantId, id, patch, userId);
    if (!next) return { error: '素材が見つかりません' };
    if (patch.isInterrupt !== undefined) await this.audit(tenantId, userId, 'signage.interrupt_asset.set', id, { isInterrupt: patch.isInterrupt });
    // 画面は割り込みの素材を取り置き直す
    this.emit(tenantId, '*', 'settings');
    return { asset: next };
  }

  /** 素材の名前を直す。 */
  async renameAsset(tenantId: string, userId: string, id: string, name: unknown): Promise<{ asset: SignageAsset } | { error: string }> {
    const n = String(name ?? '').trim();
    if (!n || [...n].length > 60) return { error: '名前は 1〜60 字にしてください' };
    const a = await this.deps.store.renameAsset(tenantId, id, n, userId);
    return a ? { asset: a } : { error: '素材が見つかりません' };
  }

  /**
   * 素材を消す。流れに入っていても断らず、流れからも外す（確認を挟まない。第31.6.1節）。
   *
   * @remarks 危険度: 低（会社の素材を消す）
   * @returns 外した画面の名前
   */
  async deleteAsset(tenantId: string, userId: string, id: string): Promise<{ screens: string[] } | null> {
    const a = await this.deps.store.getAsset(tenantId, id);
    if (!a) return null;
    const r = await this.deps.store.deleteAsset(tenantId, id);
    if (!r) return null;
    await this.deps.files.remove(tenantId, assetKey(id));
    const screens = await this.deps.store.listScreens(tenantId);
    const names = r.screens.map((s) => screens.find((x) => x.id === s)?.name ?? '').filter(Boolean);
    await this.audit(tenantId, userId, 'signage.asset.remove', id, { name: a.name, kind: a.kind, bytes: a.bytes, sha256: a.sha256, screens: names });
    for (const s of r.screens) this.emit(tenantId, s, 'flow');
    return { screens: names };
  }

  /** 画面の流れと版。 */
  async flow(tenantId: string, screenId: string): Promise<{ version: number; entries: SignageEntry[] } | null> {
    const s = await this.deps.store.getScreen(tenantId, screenId);
    if (!s || s.status !== 'active') return null;
    return { version: s.flowVersion, entries: await this.deps.store.listEntries(tenantId, screenId) };
  }

  /**
   * 流れを並びごと置き換える（第31.6.2節）。読んだ版と違えば断る（409）。
   *
   * @remarks 危険度: 低（社内の画面に出すものを変える。ADR-0051）
   */
  async replaceFlow(tenantId: string, userId: string, screenId: string, input: unknown, version: unknown): Promise<{ version: number } | { error: string; status: number }> {
    if (!Array.isArray(input)) return { error: '流れの形が違います', status: 400 };
    if (input.length > SIGNAGE_LIMITS.entries) return { error: `流れは ${SIGNAGE_LIMITS.entries} 行までです`, status: 400 };
    if (typeof version !== 'number' || !Number.isInteger(version)) return { error: '流れの版がありません', status: 400 };
    const assets = new Map((await this.deps.store.listAssets(tenantId)).map((a) => [a.id, a]));
    const entries: SignageEntry[] = [];
    for (const raw of input as { assetId?: unknown; seconds?: unknown }[]) {
      const a = assets.get(String(raw?.assetId ?? ''));
      if (!a) return { error: '流れに無い素材が入っています', status: 400 };
      let seconds: number | null = null;
      if (a.kind !== 'video' && raw.seconds !== null && raw.seconds !== undefined && raw.seconds !== '') {
        const n = Number(raw.seconds);
        if (!Number.isInteger(n) || n < SIGNAGE_LIMITS.minSeconds || n > SIGNAGE_LIMITS.maxSeconds) return { error: `秒数は ${SIGNAGE_LIMITS.minSeconds}〜${SIGNAGE_LIMITS.maxSeconds} 秒にしてください`, status: 400 };
        seconds = n;
      }
      entries.push({ assetId: a.id, seconds });
    }
    const next = await this.deps.store.replaceEntries(tenantId, screenId, entries, version, userId);
    if (next === null) {
      return (await this.deps.store.getScreen(tenantId, screenId))?.status === 'active'
        ? { error: 'ほかの人が先に流れを直しました。読み直してからもう一度直してください', status: 409 }
        : { error: '画面が見つかりません', status: 404 };
    }
    // 同じ人が同じ画面を 10 分の間に続けて直したときは、監査ログを 1 件にまとめる
    const k = `${tenantId}:${userId}:${screenId}`;
    const last = this.flowAudits.get(k) ?? 0;
    if (this.now().getTime() - last > 10 * 60_000) {
      await this.audit(tenantId, userId, 'signage.flow.update', screenId, { entries: entries.length, version: next });
      this.flowAudits.set(k, this.now().getTime());
    }
    this.emit(tenantId, screenId, 'flow');
    return { version: next };
  }

  /** 画面の鍵から画面を引く（再生のページ）。外した画面・違う会社の鍵は `null`。 */
  async screenByKey(tenantId: string, key: string | null): Promise<ScreenRecord | null> {
    if (!key || !SECRET_FORMAT.test(key)) return null;
    return this.deps.store.findScreenByKey(tenantId, hashSecret(key));
  }

  /**
   * 再生のページに渡す状態（設定・流れと版・素材・店の色・会社の名前・サーバーの時刻。第31.15.2節）。
   */
  async playState(tenantId: string, s: ScreenRecord): Promise<{
    screen: { id: string; name: string; orientation: SignageOrientation; rotation: SignageRotation; volume: number; flowVersion: number };
    entries: SignageEntry[]; assets: PlayAsset[]; interruptAssets: string[]; sounds: { id: string; mime: string }[]; jingle: string;
    imageSeconds: number; color: string; company: string; serverTime: string;
  }> {
    const [entries, all, tenantSettings, tenant, sounds] = await Promise.all([
      this.deps.store.listEntries(tenantId, s.id), this.deps.store.listAssets(tenantId), this.deps.repo.getTenantSettings(tenantId), this.deps.repo.findTenantById(tenantId),
      this.deps.store.listSounds(tenantId),
    ]);
    const used = new Set(entries.map((e) => e.assetId));
    // 割り込みの素材も取り置く（つながらない間にも出せるように。第31.9.1節）
    const interrupts = all.filter((a) => a.isInterrupt && a.kind !== 'video');
    for (const a of interrupts) used.add(a.id);
    return {
      screen: { id: s.id, name: s.name, orientation: s.orientation, rotation: s.rotation, volume: s.volume, flowVersion: s.flowVersion },
      entries,
      assets: all.filter((a) => used.has(a.id)).map(({ id, kind, mime, sha256, bytes, width, height, durationMs, caption }) => ({ id, kind, mime, sha256, bytes, width, height, durationMs, caption })),
      interruptAssets: interrupts.map((a) => a.id),
      sounds: sounds.map((x) => ({ id: x.id, mime: x.mime })),
      jingle: tenantSettings.signage.jingle,
      imageSeconds: tenantSettings.signage.imageSeconds,
      color: tenantSettings.signage.color ?? SIGNAGE_DEFAULT_COLOR,
      company: tenantSettings.company.legalName || tenant?.name || '',
      serverTime: this.now().toISOString(),
    };
  }

  /** 画面が読める素材か（その画面の流れの素材と、会社の割り込みの素材だけ。第31.5.1節）。 */
  async screenCanRead(tenantId: string, screenId: string, assetId: string): Promise<SignageAsset | null> {
    const a = await this.deps.store.getAsset(tenantId, assetId);
    if (!a) return null;
    if (a.isInterrupt && a.kind !== 'video') return a;
    const entries = await this.deps.store.listEntries(tenantId, screenId);
    return entries.some((e) => e.assetId === assetId) ? a : null;
  }

  /** 生きている知らせを受ける（第31.5.1節）。答えにサーバーの時刻と流れの版。 */
  async heartbeat(tenantId: string, s: ScreenRecord, report: unknown): Promise<{ serverTime: string; flowVersion: number }> {
    const now = this.now();
    await this.deps.store.touchScreen(tenantId, s.id, cleanReport(report));
    const { day, slot } = jstSlot(now);
    await this.deps.store.markPresence(tenantId, s.id, day, slot);
    return { serverTime: now.toISOString(), flowVersion: s.flowVersion };
  }

  /**
   * 見回り（ワーカーから）。つながらない画面を知らせ、切れた番号・古い時間帯の記録・外して 30 日を過ぎた画面を消す（第31.5.1節）。
   *
   * @returns 知らせた数
   */
  async sweep(tenantId: string): Promise<{ notified: number }> {
    const now = this.now();
    await this.deps.store.purge(tenantId, now);
    const settings = await this.deps.repo.getTenantSettings(tenantId);
    if (!settings.signage.enabled) return { notified: 0 };
    const { day, slot } = jstSlot(now);
    const since = new Date(now.getTime() - 14 * 86_400_000);
    let notified = 0;
    for (const s of await this.deps.store.listScreens(tenantId)) {
      if (!s.lastSeenAt || s.offlineNotifiedAt) continue;
      if (now.getTime() - Date.parse(s.lastSeenAt) < OFFLINE_NOTIFY_MS) continue;
      const days = (await this.deps.store.listPresence(tenantId, s.id, jstSlot(since).day)).filter((d) => d.day !== day);
      if (!usualSlot(days, slot)) continue;
      for (const userId of await this.recipients(tenantId)) {
        const prefs = await this.deps.repo.getUserSettings(tenantId, userId);
        if (!prefs.notifications.kinds.signage) continue;
        await this.deps.repo.createNotification({
          id: randomUUID(), tenantId, userId, kind: 'signage', title: `サイネージの「${s.name}」が未接続です`,
          body: '画面の端末の電源とネットワークを確かめてください', runId: null, readAt: null, createdAt: now.toISOString(),
        });
      }
      await this.deps.store.setOfflineNotified(tenantId, s.id);
      notified++;
    }
    return { notified };
  }

  /** つながらない知らせの相手。利用範囲の中の管理者、いなければ会社の管理者（第31.5.1節）。 */
  private async recipients(tenantId: string): Promise<string[]> {
    const { repo } = this.deps;
    const settings = await repo.getTenantSettings(tenantId);
    const admins = (await repo.listUsers(tenantId)).filter((u) => u.status === 'active' && u.roles.includes('admin'));
    const inScope: string[] = [];
    for (const u of admins) if (canUseAgent(settings.access, SIGNAGE_EXTENSION_ID, u.id, await repo.listUserGroupIds(tenantId, u.id))) inScope.push(u.id);
    return inScope.length ? inScope : admins.map((u) => u.id);
  }
}

/** 空いている「画面 N」の名前。 */
function freeName(used: string[]): string {
  for (let i = 1; ; i++) if (!used.includes(`画面 ${i}`)) return `画面 ${i}`;
}

/** HTML の文書か（種類か、中身の先頭で決める）。 */
function isHtml(mime: string, head: Uint8Array): boolean {
  if (/^text\/html\b/i.test(mime)) return true;
  const s = new TextDecoder().decode(head.slice(0, 512)).replace(/^\uFEFF/, '').trimStart().toLowerCase();
  return s.startsWith('<!doctype html') || s.startsWith('<html');
}

/**
 * HTML の中に残った外への参照（`http:`・`https:`・`//` で始まるもの）。画像・スクリプト・CSS・字体・囲い・フォームの送り先・移動の印（第31.6.3節）。
 *
 * @returns 見つかった参照（重ねない）
 */
export function externalRefs(html: string): string[] {
  const out = new Set<string>();
  const ext = /^\s*(?:https?:|\/\/)/i;
  for (const m of html.matchAll(/\b(?:src|href|action|formaction|poster|data|background|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const v = m[1] ?? m[2] ?? m[3] ?? '';
    if (ext.test(v)) out.add(v.trim().slice(0, 80));
  }
  for (const m of html.matchAll(/\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    for (const part of (m[1] ?? m[2] ?? '').split(',')) if (ext.test(part)) out.add(part.trim().split(/\s+/)[0]!.slice(0, 80));
  }
  for (const m of html.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) if (ext.test(m[2] ?? '')) out.add(m[2]!.trim().slice(0, 80));
  for (const m of html.matchAll(/@import\s+(['"])([^'"]+)\1/gi)) if (ext.test(m[2] ?? '')) out.add(m[2]!.trim().slice(0, 80));
  for (const m of html.matchAll(/<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi)) {
    const u = /url\s*=\s*([^"'>;]+)/i.exec(m[0])?.[1];
    if (u && ext.test(u)) out.add(u.trim().slice(0, 80));
  }
  return [...out];
}

const fmtBytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);

/**
 * サイネージを使えるか（会社の入り切りと利用範囲。第31.2節）。使えれば会社の設定を返す。
 */
export function signageAccess(repo: Repository) {
  return async (tenantId: string, userId: string): Promise<SignageSettings | null> => {
    const settings = await repo.getTenantSettings(tenantId);
    if (!settings.signage.enabled) return null;
    const groups = await repo.listUserGroupIds(tenantId, userId);
    if (!canUseAgent(settings.access, SIGNAGE_EXTENSION_ID, userId, groups)) return null;
    return settings.signage;
  };
}
